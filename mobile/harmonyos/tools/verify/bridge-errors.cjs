const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts, util } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')
const bytes = loadArkts(
  'transport/crypto/Bytes.ets',
  ['utf8Encode', 'utf8Decode', 'base64Encode'],
  { util }
)
const hostId = 'a'.repeat(32)
const manifest = {
  buildId: 'test',
  routes: [
    { pathname: '/h/[hostId]', canOwnHostArea: true, grants: ['navigate'], optionalGrants: [] }
  ]
}
function createBridge(peer, client) {
  const frames = []
  const controller = {
    runJavaScript(script) {
      frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const bridge = new BridgeHost(
    client,
    controller,
    manifest,
    { id: hostId, name: 'test', endpoint: 'ws://test' },
    `/h/${hostId}`
  )
  bridge.onPushChannelReady()
  return { bridge, frames }
}
function post(bridge, message) {
  bridge.onClientMessage(JSON.stringify({ v: 1, type: 'request', ...message }))
}

test('an unconfirmed mutation timeout reaches the page with delivery ambiguity intact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  const { bridge, frames } = createBridge(peer, client)
  post(bridge, { id: 'mutation', method: 'worktree.create', options: { timeoutMs: 1000 } })
  t.mock.timers.tick(1000)
  await new Promise(setImmediate)
  assert.equal(frames[0].type, 'error')
  assert.equal(frames[0].error.category, 'Error')
  assert.equal(frames[0].error.isRpcDeliveryUnknown, true)
  bridge.dispose()
  client.close()
})

test('a refused duplicate request sends the page a readable definite failure', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  const { bridge, frames } = createBridge(peer, client)
  post(bridge, { id: 'same', method: 'status.get' })
  post(bridge, { id: 'same', method: 'status.get' })
  assert.equal(frames[0].type, 'error')
  assert.equal(frames[0].error.category, 'Error')
  assert.equal(frames[0].error.isRpcDeliveryUnknown, false)
  bridge.dispose()
  client.close()
})
