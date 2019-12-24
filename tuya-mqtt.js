const debug = require('debug')('TuyAPI:mqtt');
const debugColor = require('debug')('TuyAPI:mqtt:color');
const debugTuya = require('debug')('TuyAPI:mqtt:device');
const debugError = require('debug')('TuyAPI:mqtt:error');

const mqtt = require('mqtt');
const TuyaDevice = require('./tuya-device');

require('./cleanup').Cleanup(onExit);

function bmap(istate) {
	return istate ? 'ON' : 'OFF';
}

let CONFIG = {
	qos: 2,
	retain: false,
	mqtt_user: '',
	mqtt_pass: ''
};

try {
	CONFIG = Object.assign(CONFIG, require('./config'));
} catch (error) {
	console.error('Configuration file not found');
	debugError(error);
	process.exit(1);
}

class MqttClientManager {
	constructor() {
		this._connected = false;
		this.mqttClient = null;
		this.interval = null;
	}

	init() {
		const self = this;

		this.mqttClient = mqtt.connect({
			host: CONFIG.host,
			port: CONFIG.port,
			username: CONFIG.mqtt_user,
			password: CONFIG.mqtt_pass
		});

		this.mqttClient.on('connect', this.handleConnect.bind(this));
		this.mqttClient.on('reconnect', this.handleReconnect.bind(this));
		this.mqttClient.on('error', this.handleClientError.bind(this));
		this.mqttClient.on('message', this.handleClientMessage.bind(this));

		this.connect();

		/**
         * Event fires if TuyaDevice sends data
         * @see TuyAPI (https://github.com/codetheweb/tuyapi)
         */
		TuyaDevice.onAll('data', function (data) {
			try {
				if (typeof data.dps !== 'undefined') {
					debugTuya('Data from device ' + this.type + ' :', data);
					const status = data.dps['1'];
					if (typeof status !== 'undefined') {
						self.publishStatus(this, bmap(status));
					}

					self.publishDPS(this, data.dps);
				}
			} catch (error) {
				debugError(error);
			}
		});
	}

	handleConnect() {
		debug('Verbindung mit MQTT-Server hergestellt');
		this._connected = true;
		const topic = CONFIG.topic + '#';
		this.mqttClient.subscribe(topic, {
			retain: CONFIG.retain,
			qos: CONFIG.qos
		});
	}

	handleClientMessage(topic, message) {
		try {
			message = message.toString();
			const action = getActionFromTopic(topic);
			const options = getDeviceFromTopic(topic);

			debug('receive settings', JSON.stringify({
				topic,
				action,
				message,
				options
			}));

			const device = new TuyaDevice(options);
			device.then(params => {
				const {device} = params;

				switch (action) {
					case 'command':
						const command = getCommandFromTopic(topic, message);
						debug('receive command', command);
						if (command === 'toggle') {
							device.switch(command).then(data => {
								debug('set device status completed', data);
							});
						} else {
							device.set(command).then(data => {
								debug('set device status completed', data);
							});
						}

						break;
					case 'color':
						const color = message.toLowerCase();
						debugColor('set color: ', color);
						device.setColor(color).then(data => {
							debug('set device color completed', data);
						});
						break;
				}
			}).catch(error => {
				debugError(error);
			});
		} catch (error) {
			debugError(error);
		}
	}

	handleReconnect(error) {
		if (this.connected) {
			debug('Verbindung mit MQTT-Server wurde unterbrochen. Erneuter Verbindungsversuch!');
		} else {
			debug('Verbindung mit MQTT-Server konnte nicht herrgestellt werden.');
		}
	}

	handleClientError(error) {
		debug('Verbindung mit MQTT-Server konnte nicht herrgestellt werden.', error);
		this._connected = false;
	}

	get connected() {
		return this._connected;
	}

	/**
     * Publish current TuyaDevice state to MQTT-Topic
     * @param {TuyaDevice} device
     * @param {boolean} status
     */
	publishStatus(device, status) {
		if (this.connected) {
			try {
				const {type} = device;
				const tuyaID = device.options.id;
				const tuyaKey = device.options.key;
				const tuyaIP = device.options.ip;

				if (typeof tuyaID !== 'undefined' && typeof tuyaKey !== 'undefined' && typeof tuyaIP !== 'undefined') {
					let {topic} = CONFIG;
					if (typeof type !== 'undefined') {
						topic += type + '/';
					}

					topic += `${tuyaID}/${tuyaKey}/${tuyaIP}/state`;

					this.mqttClient.publish(topic, status, {
						retain: CONFIG.retain,
						qos: CONFIG.qos
					});
					debugTuya('mqtt status updated to:' + topic + ' -> ' + status);
				} else {
					debugTuya('mqtt status not updated');
				}
			} catch (error) {
				debugError(error);
			}
		}
	}

	/**
     * Publish all dps-values to topic
     * @param  {TuyaDevice} device
     * @param  {Object} dps
     */
	publishDPS(device, dps) {
		if (this.connected) {
			try {
				const {type} = device;
				const tuyaID = device.options.id;
				const tuyaKey = device.options.key;
				const tuyaIP = device.options.ip;

				if (typeof tuyaID !== 'undefined' && typeof tuyaKey !== 'undefined' && typeof tuyaIP !== 'undefined') {
					let baseTopic = CONFIG.topic;
					if (typeof type !== 'undefined') {
						baseTopic += type + '/';
					}

					baseTopic += `${tuyaID}/${tuyaKey}/${tuyaIP}/dps`;

					const topic = baseTopic;
					const data = JSON.stringify(dps);
					debugTuya(`mqtt dps updated to:${topic} -> `, data);
					this.mqttClient.publish(topic, data, {
						retain: CONFIG.retain,
						qos: CONFIG.qos
					});

					Object.keys(dps).forEach(key => {
						const topic = `${baseTopic}/${key}`;
						const data = JSON.stringify(dps[key]);
						debugTuya(`mqtt dps updated to:${topic} -> dps[${key}]`, data);
						this.mqttClient.publish(topic, data, {
							retain: CONFIG.retain,
							qos: CONFIG.qos
						});
					});
				} else {
					debugTuya('mqtt dps not updated');
				}
			} catch (error) {
				debugError(error);
			}
		}
	}

	mqttConnectionTest() {
		if (this.mqttClient.connected !== this.connected) {
			this._connected = this.mqttClient.connected;
			if (this._connected) {
				debug('MQTT-Server verbunden.');
			} else {
				debug('MQTT-Server nicht verbunden.');
			}
		}
	}

	destroy() {
		clearInterval(this.interval);
		this.interval = undefined;
	}

	connect() {
		this.interval = setInterval(this.mqttConnectionTest.bind(this), 1500);
		this.mqttConnectionTest();
	}
}

/**
 * Execute function on topic message
 */

function isJsonString(text) {
	return /^[\],:{}\s]*$/.test(text.replace(/\\["\\\/bfnrtu]/g, '@')
		.replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
		.replace(/(?:^|:|,)(?:\s*\[)+/g, ''));
}

/**
 * Check mqtt-topic string for old notation with included device type
 * @param {String} _topic
 */
function checkTopicForOldNotation(_topic) {
	const topic = _topic.split('/');
	const type = topic[1];
	return (type === 'socket' || type === 'lightbulb');
}

/**
 * Get action from mqtt-topic string
 * @param {String} _topic
 * @returns {String} action type
 */
function getActionFromTopic(_topic) {
	const topic = _topic.split('/');

	if (checkTopicForOldNotation(_topic)) {
		return topic[5];
	}

	return topic[4];
}

/**
 * Get device informations from mqtt-topic string
 * @param {String} _topic
 * @returns {String} object.id
 * @returns {String} object.key
 * @returns {String} object.ip
 */
function getDeviceFromTopic(_topic) {
	const topic = _topic.split('/');

	if (checkTopicForOldNotation(_topic)) {
		return {
			id: topic[2],
			key: topic[3],
			ip: topic[4],
			type: topic[1]
		};
	}

	return {
		id: topic[1],
		key: topic[2],
		ip: topic[3]
	};
}

/**
 * Get command from mqtt - topic string
 * converts simple commands to TuyAPI JSON commands
 * @param {String} _topic
 * @param _message
 * @returns {Object}
 */
function getCommandFromTopic(_topic, _message) {
	const topic = _topic.split('/');
	let command;

	if (checkTopicForOldNotation(_topic)) {
		command = topic[6];
	} else {
		command = topic[5];
	}

	if (command == null) {
		command = _message;
	}

	if (command !== '1' && command !== '0' && isJsonString(command)) {
		debug('command is JSON');
		command = JSON.parse(command);
	} else if (command.toLowerCase() !== 'toggle') {
		// Convert simple commands (on, off, 1, 0) to TuyAPI-Commands
		const convertString = Boolean(command.toLowerCase() === 'on' || command === '1' || command === 1);
		command = {
			set: convertString
		};
	} else {
		command = command.toLowerCase();
	}

	return command;
}

const mqttClientManager = new MqttClientManager();
mqttClientManager.init();

/**
 * Function call on script exit
 */
function onExit() {
	TuyaDevice.disconnectAll();
	if (mqttClientManager) {
		mqttClientManager.destroy();
	}
}
