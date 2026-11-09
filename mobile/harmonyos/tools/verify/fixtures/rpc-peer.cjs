const { loadArkts, util } = require('../arkts-source.cjs')

function createRpcPeer({ authenticate = true } = {}) {
  let socket
  let failSend = false
  const sent = []
  const handlers = new Map()
  const receive = (value) => handlers.get('message')(null, value)
  const webSocket = {
    createWebSocket() {
      socket = {
        on(name, handler) {
          handlers.set(name, handler)
        },
        connect(_endpoint, callback) {
          callback(null)
          handlers.get('open')(null, {})
        },
        send(frame) {
          if (failSend) {
            return Promise.reject(new Error('offline'))
          }
          if (authenticate && frame === 'hello') {
            receive('{}')
          } else if (authenticate && frame === 'auth') {
            receive('{"type":"e2ee_authenticated","v":2,"transcriptHashB64":"transcript"}')
          } else {
            sent.push(frame)
            const request =
              typeof frame === 'string' && frame.startsWith('{') ? JSON.parse(frame) : null
            if (request?.method === 'runtime.clientCapabilities.update') {
              receive(JSON.stringify({ id: request.id, ok: true, result: {} }))
            }
          }
          return Promise.resolve()
        },
        close() {
          return Promise.resolve()
        }
      }
      return socket
    }
  }
  class TestCipher {
    helloJson = 'hello'
    transcriptHashB64 = 'transcript'
    setPinnedKey() {}
    acceptReady() {
      return true
    }
    sealText(text) {
      return text
    }
    openText(text) {
      return text
    }
    openBinary(bytes) {
      return bytes[0] === 0xee ? bytes.subarray(1) : null
    }
  }
  const rpc = loadArkts(
    'transport/SpikeRpcClient.ets',
    ['SpikeRpcClient', 'RpcSuccess', 'RpcFailure'],
    {
      webSocket,
      textDecoderUtil: util,
      E2eeV2ClientSession: TestCipher,
      buildV2TokenAuthJson: () => 'auth'
    }
  )
  const capabilities = loadArkts('transport/RuntimeCapabilities.ets', ['settleRuntimeCapabilities'])
  return {
    ...rpc,
    ...capabilities,
    fflateModule: require('../../../entry/src/main/ets/vendor/fflate-umd.js'),
    sent,
    close: (code = 1006, reason = 'reset') => handlers.get('close')(null, { code, reason }),
    failSend: () => {
      failSend = true
    },
    receiveText: receive,
    receiveBinary: (bytes) => receive(Uint8Array.from([0xee, ...bytes]).buffer)
  }
}
module.exports = { createRpcPeer }
