const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { loadArkts, util } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')
const bytes = loadArkts(
  'transport/crypto/Bytes.ets',
  ['utf8Encode', 'utf8Decode', 'base64Encode', 'base64DecodeCanonical', 'concatBytes', 'toHex'],
  { util }
)
const { sha256 } = loadArkts('transport/crypto/Sha256.ets', ['sha256'])
const nacl = loadArkts(
  'transport/NaclBinding.ets',
  ['naclRandomBytes', 'naclSecretbox', 'naclSecretboxOpen'],
  {
    naclModule: require('../../entry/src/main/ets/vendor/nacl-fast.min.js'),
    cryptoFramework: {
      createRandom: () => ({
        generateRandomSync: (length) => ({ data: new Uint8Array(crypto.randomBytes(length)) })
      })
    }
  }
)
const hostId = '1234567890abcdef1234567890abcdef'
const meta = { id: hostId, name: 'test', endpoint: 'ws://test', publicKeyB64: 'key' }
const post = (bridge, frame) => bridge.onClientMessage(JSON.stringify({ v: 1, ...frame }))
function controller() {
  const frames = []
  return {
    frames,
    runJavaScript(script) {
      frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
}
async function bridgeSession(grants = []) {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'synthetic-token', 'key', 'v2')
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const view = controller()
  const manifest = {
    buildId: 'test',
    routes: [{ pathname: '/h/[hostId]', grants, optionalGrants: [], canOwnHostArea: true }]
  }
  const bridge = new BridgeHost(client, view, manifest, meta, `/h/${hostId}`)
  bridge.onPushChannelReady()
  return { ...peer, client, bridge, view }
}

test('large multilingual desktop replies reach the page in bounded reconstructable parts', async () => {
  const { bridge, client, view, sent, receiveText } = await bridgeSession()
  post(bridge, { type: 'request', id: 'large', method: 'git.diff', params: {} })
  const { id } = JSON.parse(sent.at(-1))
  const value = '雪😀"\\'.repeat(120000)
  receiveText(JSON.stringify({ id, ok: true, result: { diff: value } }))
  await Promise.resolve()
  const frames = view.frames.filter((frame) => frame.id === 'large')
  assert.ok(frames.length > 1)
  assert.ok(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 655360))
  assert.equal(JSON.parse(frames.map((frame) => frame.chunk).join('')).result.diff, value)
  bridge.dispose()
  client.close()
})

test('a granted browser stream delivers its image bytes and stops after cancellation', async () => {
  const { bridge, client, view, sent, receiveText, receiveBinary } = await bridgeSession([
    'screencastBinary'
  ])
  post(bridge, {
    type: 'subscribe',
    id: 'screen',
    method: 'browser.screencast',
    params: { page: 'page' },
    wantsBinary: true
  })
  const { id } = JSON.parse(sent.at(-1))
  receiveText(
    JSON.stringify({
      id,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'server-stream' }
    })
  )
  const metadata = Buffer.from('{"deviceWidth":640,"deviceHeight":480}')
  const frame = Buffer.alloc(16 + metadata.length + 3)
  frame.set([0x62, 1, 1, 1])
  frame.writeUInt32LE(7, 4)
  frame.writeUInt32LE(metadata.length, 8)
  metadata.copy(frame, 16)
  frame.set([0xff, 0xd8, 0xff], 16 + metadata.length)
  receiveBinary(frame)
  const received = view.frames.find((value) => value.binary)
  assert.equal(received.id, 'screen')
  assert.equal(received.binary.format, 'jpeg')
  assert.equal(received.binary.frameSeq, 7)
  assert.deepEqual(Buffer.from(received.binary.b64, 'base64'), Buffer.from([0xff, 0xd8, 0xff]))
  post(bridge, { type: 'cancel', id: 'screen' })
  const count = view.frames.length
  receiveBinary(frame)
  assert.equal(view.frames.length, count)
  bridge.dispose()
  client.close()
})

test('cancel before browser ready releases the remote subscription when its identity arrives', async () => {
  const { bridge, client, sent, receiveText } = await bridgeSession(['screencastBinary'])
  post(bridge, {
    type: 'subscribe',
    id: 'pending',
    method: 'browser.screencast',
    params: { page: 'page' },
    envelope: { executionHost: 'runtime:server' }
  })
  post(bridge, { type: 'cancel', id: 'pending' })
  const { id } = JSON.parse(sent.at(-1))
  receiveText(
    JSON.stringify({
      id,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'server-stream' }
    })
  )
  const unsubscribe = sent
    .map((wire) => JSON.parse(wire))
    .find((wire) => wire.method === 'browser.screencast.unsubscribe')
  assert.equal(unsubscribe.params.subscriptionId, 'server-stream')
  assert.equal(unsubscribe.executionHost, 'runtime:server')
  bridge.dispose()
  client.close()
})

function deviceRows(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-device-rows-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const secrets = new Map()
  const asset = {
    Tag: { ALIAS: 'alias', SECRET: 'secret', RETURN_TYPE: 'return' },
    ReturnType: { ALL: 1 },
    ErrorCode: { NOT_FOUND: 404 },
    async query(query) {
      const key = Buffer.from(query.get('alias')).toString()
      if (!secrets.has(key)) {
        throw Object.assign(new Error('not found'), { code: 404 })
      }
      return [new Map([['secret', secrets.get(key)]])]
    },
    async add(value) {
      secrets.set(Buffer.from(value.get('alias')).toString(), value.get('secret'))
    },
    async remove(query) {
      secrets.delete(Buffer.from(query.get('alias')).toString())
    }
  }
  let rejectWrite = false
  const fileIo = {
    OpenMode: {
      CREATE: fs.constants.O_CREAT,
      READ_WRITE: fs.constants.O_RDWR,
      TRUNC: fs.constants.O_TRUNC
    },
    accessSync: fs.existsSync,
    listFileSync: fs.readdirSync,
    statSync(name) {
      const stat = fs.statSync(name)
      return { size: stat.size, mtime: stat.mtimeMs, isDirectory: () => stat.isDirectory() }
    },
    readTextSync: (name) => fs.readFileSync(name, 'utf8'),
    mkdirSync: (name, recursive) => fs.mkdirSync(name, { recursive }),
    openSync: (name, flags) => ({ fd: fs.openSync(name, flags) }),
    writeSync(fd, value) {
      if (rejectWrite) {
        return 0
      }
      return fs.writeSync(fd, value)
    },
    fsyncSync: fs.fsyncSync,
    closeSync: (file) => fs.closeSync(file.fd),
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    rmdirSync: (name) => fs.rmSync(name, { recursive: true })
  }
  const api = loadArkts('storage/DeviceRowStore.ets', ['DeviceRowStore', 'deleteDeviceRows'], {
    fs: fileIo,
    asset,
    sha256,
    ...bytes,
    ...nacl
  })
  return {
    ...api,
    context: { filesDir: path.join(root, 'files'), cacheDir: path.join(root, 'cache') },
    failWrites() {
      rejectWrite = true
    }
  }
}

test('device rows survive reopening and remain scoped to their host and table', async (t) => {
  const { DeviceRowStore, context } = deviceRows(t)
  const first = new DeviceRowStore(context, hostId)
  const write = await first.serve({
    action: 'write',
    table: 'draft',
    ops: [{ key: 'compose', value: 'fixed-draft' }]
  })
  assert.equal(write.written, true)
  const reopened = new DeviceRowStore(context, hostId)
  assert.deepEqual(
    Array.from(
      (await reopened.serve({ action: 'read', table: 'draft', keys: ['compose'] })).values
    ),
    ['fixed-draft']
  )
  assert.deepEqual(
    Array.from(
      (await reopened.serve({ action: 'read', table: 'cache', keys: ['compose'] })).values
    ),
    [null]
  )
  const otherHost = new DeviceRowStore(context, 'abcdefabcdefabcdefabcdefabcdefab')
  assert.deepEqual(
    Array.from(
      (await otherHost.serve({ action: 'read', table: 'draft', keys: ['compose'] })).values
    ),
    [null]
  )
})

test('a partial disk write is refused without replacing the committed draft', async (t) => {
  const { DeviceRowStore, context, failWrites } = deviceRows(t)
  const store = new DeviceRowStore(context, hostId)
  await store.serve({
    action: 'write',
    table: 'draft',
    ops: [{ key: 'compose', value: 'keep-me' }]
  })
  failWrites()
  assert.equal(
    (
      await store.serve({
        action: 'write',
        table: 'draft',
        ops: [{ key: 'compose', value: 'incomplete' }]
      })
    ).written,
    false
  )
  assert.deepEqual(
    Array.from((await store.serve({ action: 'read', table: 'draft', keys: ['compose'] })).values),
    ['keep-me']
  )
})
