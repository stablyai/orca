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
async function bridgeSession(grants = [], pathname = `/h/${hostId}`) {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'synthetic-token', 'key', 'v2')
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const view = controller()
  const manifest = {
    buildId: 'test',
    routes: [
      {
        pathname: '/h/[hostId]',
        grants,
        optionalGrants: [],
        canOwnHostArea: true,
        canOwnHostAreaAcrossLayouts: true
      },
      { pathname: '/h/[hostId]/session/[worktreeId]', grants, optionalGrants: [] }
    ]
  }
  const bridge = new BridgeHost(client, view, manifest, meta, pathname)
  bridge.onPushChannelReady()
  return { ...peer, client, bridge, view }
}

test('a host-area document can save and read chat view after entering a workspace', async () => {
  const { bridge, client, view } = await bridgeSession(['storage'])
  const key = `orca:nativeChatTabs:${hostId}:tree`
  const foreignKey = 'orca:nativeChatTabs:other-host:tree'
  bridge.setStorage({
    entries: () => new Map([[foreignKey, '{"other":"chat"}']]),
    write() {}
  })
  post(bridge, { type: 'ready' })
  post(bridge, { type: 'notify', name: 'location', href: `/h/${hostId}/session/tree` })
  post(bridge, { type: 'notify', name: 'storage', key, value: '{"tab":"chat"}' })
  post(bridge, {
    type: 'request',
    id: 'read-chat',
    method: 'native.storage.read',
    params: { key }
  })
  const reply = view.frames.find((frame) => frame.id === 'read-chat')
  assert.deepEqual(reply.payload.result, { value: '{"tab":"chat"}' })
  post(bridge, {
    type: 'request',
    id: 'read-other-host',
    method: 'native.storage.read',
    params: { key: foreignKey }
  })
  const refused = view.frames.find((frame) => frame.id === 'read-other-host')
  assert.equal(refused.error.code, 'native_verb_params')
  bridge.dispose()
  client.close()
})

test('a standalone session stores its exact workspace key without accepting a prefixed sibling', async () => {
  const pathname = `/h/${hostId}/session/tree%7Ctopic`
  const { bridge, client } = await bridgeSession(['storage'], pathname)
  const writes = new Map()
  bridge.setStorage({
    entries: () => new Map(),
    write: (key, value) => writes.set(key, value)
  })
  post(bridge, { type: 'ready' })
  post(bridge, {
    type: 'notify',
    name: 'storage',
    key: `orca:nativeChatTabs:${hostId}:tree%7Ctopic-other`,
    value: '{"other":"chat"}'
  })
  post(bridge, {
    type: 'notify',
    name: 'storage',
    key: `orca:nativeChatTabs:${hostId}:tree%7Ctopic`,
    value: '{"own":"chat"}'
  })
  assert.deepEqual([...writes], [[`orca:nativeChatTabs:${hostId}:tree%7Ctopic`, '{"own":"chat"}']])
  bridge.dispose()
  client.close()
})

test('wide workspace admission requires an implemented desktop sidebar owner', () => {
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'])
  const root = `/h/${hostId}`
  const session = `${root}/session/tree`
  const listRoute = { pathname: '/h/[hostId]', grants: ['navigate'] }
  const sessionRoute = { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'] }
  const legacy = { routes: [listRoute, sessionRoute] }
  const supports = (grant) => grant === 'navigate'

  for (const pathname of [root, session]) {
    assert.equal(BridgeHost.classifyRoute(pathname, legacy, supports, false), '')
    assert.equal(BridgeHost.classifyRoute(pathname, legacy, supports, true), 'desktop')
  }
  const wideOwner = { ...listRoute, canOwnHostArea: true }
  assert.equal(
    BridgeHost.classifyRoute(session, { routes: [wideOwner, sessionRoute] }, supports, true),
    ''
  )
  const unimplementedOwner = { ...wideOwner, grants: ['future-native-grant'] }
  assert.equal(
    BridgeHost.classifyRoute(
      session,
      { routes: [unimplementedOwner, sessionRoute] },
      supports,
      true
    ),
    'mobile'
  )
})

test('a standalone session can show its desktop sidebar when expanded and return to its native list', async (t) => {
  const root = `/h/${hostId}`
  const pathname = `${root}/session/tree`
  const { bridge, client, view } = await bridgeSession(['navigate', 'storage'], pathname)
  t.after(() => {
    bridge.dispose()
    client.close()
  })
  bridge.setDesktopListBack()
  assert.equal(bridge.layoutChangesRouteView(true), true)
  bridge.setWideLayout(true)
  const siblingKey = `orca:nativeChatTabs:${hostId}:another-workspace`
  const foreignKey = 'orca:nativeChatTabs:other-host:tree'
  const writes = new Map()
  bridge.setStorage({
    entries: () => new Map(),
    write: (key, value) => writes.set(key, value)
  })
  const backs = []
  bridge.setNavigation(
    (home) => backs.push(home),
    () => {}
  )
  post(bridge, { type: 'ready' })
  const init = view.frames.find((frame) => frame.type === 'init')
  assert.equal(init.ownsHostArea, true)
  assert.equal(init.route.pathname, pathname)
  assert.deepEqual(init.pageRoutes, ['/h/[hostId]/session/[worktreeId]'])
  for (const key of [siblingKey, foreignKey]) {
    post(bridge, { type: 'notify', name: 'storage', key, value: '{"tab":"chat"}' })
    post(bridge, { type: 'request', id: key, method: 'native.storage.read', params: { key } })
  }
  assert.deepEqual([...writes], [[siblingKey, '{"tab":"chat"}']])
  assert.deepEqual(view.frames.find((frame) => frame.id === siblingKey).payload.result, {
    value: '{"tab":"chat"}'
  })
  assert.equal(
    view.frames.find((frame) => frame.id === foreignKey).error.code,
    'native_verb_params'
  )
  post(bridge, { type: 'notify', name: 'navigate', href: root })
  assert.deepEqual(backs, [false])
})

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

test('switching browser view starts the next stream while the previous unsubscribe is pending', async (t) => {
  const { bridge, client, view, sent, receiveText, receiveBinary } = await bridgeSession([
    'screencastBinary'
  ])
  t.after(() => {
    bridge.dispose()
    client.close()
  })
  const subscribe = (id, page) => {
    post(bridge, {
      type: 'subscribe',
      id,
      method: 'browser.screencast',
      params: { page },
      wantsBinary: true
    })
    return JSON.parse(sent.at(-1))
  }
  const ready = (request, subscriptionId) =>
    receiveText(
      JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: {
          type: 'ready',
          subscriptionId
        }
      })
    )
  ready(subscribe('old-screen', 'page'), 'server-old')
  post(bridge, { type: 'cancel', id: 'old-screen' })
  const stop = JSON.parse(sent.at(-1))
  assert.equal(stop.method, 'browser.screencast.unsubscribe')
  const next = subscribe('new-screen', 'other-page')
  assert.equal(next.method, 'browser.screencast')
  const frame = Buffer.alloc(21)
  frame.set([0x62, 1, 1, 1])
  frame.writeUInt32LE(2, 8)
  frame.write('{}', 16)
  frame.set([0xff, 0xd8, 0xff], 18)
  receiveBinary(frame)
  assert.equal(
    view.frames.some((value) => value.binary),
    false
  )
  ready(next, 'server-new')
  receiveText(JSON.stringify({ id: stop.id, ok: true, result: { unsubscribed: true } }))
  await Promise.resolve()
  receiveBinary(frame)
  assert.deepEqual(
    view.frames.filter((value) => value.binary).map((value) => value.id),
    ['new-screen']
  )
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

test('Home restores proven counts only for the current pairing and keeps them private from pages', async (t) => {
  const { DeviceRowStore, context, deleteDeviceRows } = deviceRows(t)
  const store = new DeviceRowStore(context, hostId)
  await store.writeHomeCounts({ pairedAt: 100, totalWorktrees: 3, activeCount: 1 })
  const reopened = new DeviceRowStore(context, hostId)
  assert.deepEqual(
    { ...(await reopened.readHomeCounts(100)) },
    {
      pairedAt: 100,
      totalWorktrees: 3,
      activeCount: 1
    }
  )
  assert.equal(await reopened.readHomeCounts(200), null)
  assert.throws(
    () => reopened.serve({ action: 'read', table: 'home', keys: ['worktree-counts:v1'] }),
    /Invalid device store params/
  )
  await deleteDeviceRows(context, hostId)
  assert.equal(await new DeviceRowStore(context, hostId).readHomeCounts(100), null)
})

test('a large pairing journal survives reopening and is inaccessible to page storage', async (t) => {
  const { DeviceRowStore, context, deleteDeviceRows } = deviceRows(t)
  const store = new DeviceRowStore(context, hostId)
  const token = 'pending-desktop-pairing-token'
  const journal = JSON.stringify({ token, description: '待配对的桌面'.repeat(250) })
  await store.writePairingJournal(journal)
  const persisted = fs
    .readdirSync(context.filesDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
  assert.ok(persisted.length > 0)
  for (const entry of persisted) {
    const raw = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
    assert.equal(raw.includes(token) || Buffer.from(raw, 'base64').includes(token), false)
  }

  const reopened = new DeviceRowStore(context, hostId)
  assert.equal(await reopened.readPairingJournal(), journal)
  assert.throws(() => reopened.serve({ action: 'read', table: 'pairing', keys: ['journal'] }))
  await deleteDeviceRows(context, hostId)
  assert.equal(await reopened.readPairingJournal(), journal)
  await reopened.deletePairingJournal()
  assert.equal(await reopened.readPairingJournal(), null)
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

test('an unreadable encoded row refuses the whole batch without replacing saved text', async (t) => {
  const { DeviceRowStore, context } = deviceRows(t)
  const store = new DeviceRowStore(context, hostId)
  for (const table of ['draft', 'cache']) {
    await store.serve({
      action: 'write',
      table,
      ops: [{ key: 'compose', value: '保留的草稿' }]
    })
    const result = await store.serve({
      action: 'write',
      table,
      ops: [
        { key: 'new-row', value: 'must-not-be-saved' },
        { key: 'compose', value: '雪'.repeat(300000) }
      ]
    })
    assert.equal(result.written, false)
    assert.equal(result.refusal, 'too-large')
    const reopened = new DeviceRowStore(context, hostId)
    assert.deepEqual(
      Array.from(
        (await reopened.serve({ action: 'read', table, keys: ['compose', 'new-row'] })).values
      ),
      ['保留的草稿', null]
    )
  }
})
