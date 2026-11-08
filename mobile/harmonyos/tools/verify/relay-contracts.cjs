const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts, util } = require('./arkts-source.cjs')

function createRelayPeer({ expectedKind = 'resume', helloKind = 'resume', version = 3 } = {}) {
  const sent = []
  const contexts = []
  const handlers = new Map()
  const receive = (value) => handlers.get('message')(null, JSON.stringify(value))
  let confirm
  const webSocket = {
    createWebSocket() {
      return {
        on: (name, handler) => handlers.set(name, handler),
        connect(_endpoint, callback) {
          callback(null)
          handlers.get('open')(null, {})
        },
        send(text) {
          const frame = JSON.parse(text)
          sent.push(frame)
          if (frame.type === 'relay-auth') {
            receive({
              type: 'relay-hello',
              ok: true,
              credentialKind: helloKind,
              leaseExpiresAt: Date.now() + 60000,
              acceptedCredentialVersion: version
            })
          } else if (frame.type === 'e2ee_hello') {
            receive({})
          } else if (frame.type === 'auth') {
            receive({ type: 'e2ee_authenticated', v: 2, transcriptHashB64: 'transcript' })
          } else if (frame.method === 'pairing.getEndpoints') {
            confirm = () =>
              receive({
                id: frame.id,
                ok: true,
                result: {
                  relay: { relayHostId: 'abcdefghijklmnop' },
                  resumeConfirmation: {
                    v: 1,
                    reqId: frame.params.resumeConfirmReqId,
                    currentVersion: version,
                    acceptedAs: 'current',
                    renewed: true,
                    resumeExpiresAt: Date.now() + 86400000
                  }
                }
              })
          }
          return Promise.resolve()
        },
        close: () => Promise.resolve()
      }
    }
  }
  class Cipher {
    helloJson = '{"type":"e2ee_hello"}'
    transcriptHashB64 = 'transcript'
    constructor(transport, hostId) {
      contexts.push({ transport, hostId })
    }
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
  }
  const classes = loadArkts(
    'transport/SpikeRpcClient.ets',
    ['SpikeRpcClient', 'RpcSuccess', 'RpcFailure'],
    {
      webSocket,
      textDecoderUtil: util,
      E2eeV2ClientSession: Cipher,
      buildV2TokenAuthJson: () => '{"type":"auth"}'
    }
  )
  const client = new classes.SpikeRpcClient()
  client.configureRelay({
    relayHostId: 'abcdefghijklmnop',
    credential: 'A'.repeat(43),
    credentialKind: expectedKind,
    credentialVersion: version
  })
  return { client, sent, contexts, confirm: () => confirm() }
}

test('relay resume waits for authoritative confirmation after the outer and pinned handshakes', async () => {
  const peer = createRelayPeer()
  let connected = false
  const connecting = peer.client
    .connect('wss://cell.example/v1/connect/abcdefghijklmnop', 'device-token', 'pinned-key', 'v2')
    .then(() => {
      connected = true
    })
  assert.equal(connected, false)
  assert.equal(peer.sent[0].type, 'relay-auth')
  assert.equal(peer.sent[0].credential, 'A'.repeat(43))
  assert.equal(peer.contexts[0].transport, 'relay')
  assert.equal(peer.contexts[0].hostId, 'abcdefghijklmnop')
  assert.equal(peer.sent[3].method, 'pairing.getEndpoints')
  peer.confirm()
  await connecting
  assert.equal(peer.client.getResumeConfirmation().currentVersion, 3)
  peer.client.close()
})

test('an invite cannot be silently accepted as a stored resume credential', async () => {
  const peer = createRelayPeer({ helloKind: 'invite' })
  await assert.rejects(peer.client.connect('wss://cell.example', 'device-token', 'key', 'v2'))
  assert.equal(peer.contexts.length, 0)
})

test('relay pairing authenticates the invite before any desktop credentials are sent', async () => {
  const peer = createRelayPeer({ expectedKind: 'invite', helloKind: 'invite' })
  await peer.client.connect('wss://cell.example', 'device-token', 'key', 'v2')
  assert.deepEqual(
    peer.sent.map((frame) => frame.type),
    ['relay-auth', 'e2ee_hello', 'auth']
  )
  peer.client.close()
})
