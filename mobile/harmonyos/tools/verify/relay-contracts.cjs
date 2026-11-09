const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts, util } = require('./arkts-source.cjs')

function createRelayPeer({
  expectedKind = 'resume',
  helloKind = 'resume',
  version = 3,
  configure = {},
  refusal,
  closeOnlyCode
} = {}) {
  const sent = []
  const contexts = []
  const handlers = new Map()
  const receive = (value) => handlers.get('message')(null, JSON.stringify(value))
  const closeFromPeer = (code) => handlers.get('close')(null, { code, reason: '' })
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
            if (closeOnlyCode) {
              closeFromPeer(closeOnlyCode)
            } else {
              receive(
                refusal ?? {
                  type: 'relay-hello',
                  ok: true,
                  credentialKind: helloKind,
                  leaseExpiresAt: 4102444800000,
                  ...(helloKind === 'resume'
                    ? {
                        acceptedCredentialVersion: version,
                        acceptedAs: 'current',
                        resumeExpiresAt: 4102444800000
                      }
                    : {})
                }
              )
            }
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
                    resumeExpiresAt: 4102444800000
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
    credentialVersion: version,
    ...configure
  })
  return { client, sent, contexts, closeFromPeer, confirm: () => confirm() }
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

test('pairing recovery lets the first encrypted RPC reconcile installation and confirm resume', async () => {
  const peer = createRelayPeer({
    configure: { pairingRecovery: true, credentialVersion: undefined }
  })
  await peer.client.connect('wss://cell.example', 'device-token', 'pinned-key', 'v2')
  assert.equal(peer.client.getRelayAcceptedVersion(), 3)
  const result = peer.client.request(
    'pairing.getEndpoints',
    JSON.stringify({ installReqId: 'install-pending', resumeConfirmReqId: 'confirm-pending' })
  )
  assert.deepEqual(
    peer.sent.map((frame) => frame.method ?? frame.type),
    ['relay-auth', 'e2ee_hello', 'auth', 'pairing.getEndpoints']
  )
  assert.deepEqual(peer.sent[3].params, {
    installReqId: 'install-pending',
    resumeConfirmReqId: 'confirm-pending'
  })
  peer.confirm()
  assert.equal(JSON.parse((await result).result).resumeConfirmation.reqId, 'confirm-pending')
  peer.client.close()
})

test('a missing expected version is allowed only for recovery with a valid accepted version', async () => {
  for (const options of [
    { configure: { credentialVersion: undefined } },
    { version: 0, configure: { pairingRecovery: true, credentialVersion: undefined } },
    { configure: { pairingRecovery: true, credentialVersion: 2 } }
  ]) {
    const peer = createRelayPeer(options)
    await assert.rejects(peer.client.connect('wss://cell.example', 'device-token', 'key', 'v2'))
    assert.equal(peer.client.getRelayAcceptedVersion(), 0)
  }
})

test('only an explicit valid relay refusal rejects the credential after a socket close', async () => {
  const refused = createRelayPeer({ refusal: { type: 'relay-hello', ok: false, code: 4401 } })
  await assert.rejects(refused.client.connect('wss://cell.example', 'device-token', 'key', 'v2'))
  refused.closeFromPeer(1006)
  assert.equal(refused.client.relayCredentialRejected(), true)
  assert.equal(refused.client.getRelayCloseCode(), 4401)

  for (const options of [
    { closeOnlyCode: 4401 },
    { refusal: { type: 'relay-hello', ok: false, code: 4401, unexpected: true } }
  ]) {
    const peer = createRelayPeer(options)
    await assert.rejects(peer.client.connect('wss://cell.example', 'device-token', 'key', 'v2'))
    assert.equal(peer.client.relayCredentialRejected(), false)
  }
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
