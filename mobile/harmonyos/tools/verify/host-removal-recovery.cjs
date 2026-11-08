const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { loadArkts, util } = require('./arkts-source.cjs')

function hostStorage() {
  let now = 1800000000000
  let failJournalRemove = false
  const sha256 = (value) => Uint8Array.from(createHash('sha256').update(value).digest())
  const utf8Encode = (value) => Uint8Array.from(Buffer.from(value))
  const utf8Decode = (value) => Buffer.from(value).toString()
  const base64Encode = (value) => Buffer.from(value).toString('base64')
  const base64DecodeCanonical = (value) => {
    const bytes = Buffer.from(value, 'base64')
    return bytes.toString('base64') === value ? Uint8Array.from(bytes) : null
  }
  const clock = { now: () => now }
  const protocol = loadArkts(
    'transport/RelayProtocol.ets',
    [
      'readRelayEndpoint',
      'readRelayCredential',
      'relayBase64Url',
      'relayCredentialHash',
      'isDirectEndpoint'
    ],
    { url: { URL }, sha256, utf8Encode, base64Encode, base64DecodeCanonical, Date: clock }
  )
  const records = new Map()
  const tag = { ALIAS: 'alias', SECRET: 'secret', RETURN_TYPE: 'return' }
  const alias = (query) => utf8Decode(query.get(tag.ALIAS))
  const notFound = () => Object.assign(new Error('Asset not found'), { code: 2 })
  const asset = {
    Tag: tag,
    ReturnType: { ALL: 1 },
    ErrorCode: { DUPLICATED: 1, NOT_FOUND: 2 },
    async add(value) {
      const key = alias(value)
      if (records.has(key)) {
        throw Object.assign(new Error('Duplicate asset'), { code: 1 })
      }
      records.set(key, value.get(tag.SECRET))
    },
    async query(query) {
      const key = alias(query)
      if (!records.has(key)) {
        throw notFound()
      }
      return [new Map([[tag.SECRET, records.get(key)]])]
    },
    async update(query, value) {
      records.set(alias(query), value.get(tag.SECRET))
    },
    async remove(query) {
      const key = alias(query)
      if (key.startsWith('orca.relay.pair.') && failJournalRemove) {
        failJournalRemove = false
        throw new Error('Journal removal failed')
      }
      if (!records.delete(key)) {
        throw notFound()
      }
    }
  }
  const stores = new Map()
  function getPreferences(_context, { name }) {
    if (!stores.has(name)) {
      stores.set(name, new Map())
    }
    const stored = stores.get(name)
    return {
      async get(key, fallback) {
        return stored.has(key) ? stored.get(key) : fallback
      },
      async put(key, value) {
        stored.set(key, value)
      },
      async delete(key) {
        stored.delete(key)
      },
      async has(key) {
        return stored.has(key)
      },
      async flush() {},
      getSync(key, fallback) {
        return stored.has(key) ? stored.get(key) : fallback
      },
      putSync(key, value) {
        stored.set(key, value)
      },
      deleteSync(key) {
        stored.delete(key)
      },
      hasSync(key) {
        return stored.has(key)
      },
      flushSync() {}
    }
  }
  const preferences = {
    getPreferences: async (...args) => getPreferences(...args),
    getPreferencesSync: getPreferences
  }
  const host = loadArkts(
    'storage/HostStore.ets',
    [
      'hostIdFor',
      'saveHost',
      'deleteHost',
      'listHosts',
      'getDeviceToken',
      'getRelayCredential',
      'updateRelayCredential',
      'hostRemovalTimestamp',
      'clearHostPairingJournal'
    ],
    {
      ...protocol,
      util,
      sha256,
      utf8Decode,
      base64DecodeCanonical,
      asset,
      preferences,
      Date: clock
    }
  )
  class RpcSuccess {
    constructor(id, result) {
      this.id = id
      this.result = JSON.stringify(result)
    }
  }
  const pairing = loadArkts(
    'transport/RelayPairing.ets',
    ['prepareRelayPairing', 'commitRelayPairing', 'recoverRelayPairings'],
    {
      ...protocol,
      ...host,
      asset,
      preferences,
      utf8Encode,
      utf8Decode,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      RpcSuccess,
      Date: clock
    }
  )
  const publicKeyB64 = Buffer.alloc(32, 2).toString('base64')
  const relay = {
    v: 1,
    directorUrl: 'https://director.example',
    cellUrl: 'https://cell.example',
    assignmentEpoch: 1,
    relayHostId: protocol.relayBase64Url(sha256(Buffer.from(publicKeyB64, 'base64'))).slice(0, 16),
    e2eeFraming: 2
  }
  const offer = {
    publicKeyB64,
    deviceToken: 'paired-device-token',
    relay: { ...relay, inviteToken: 'I'.repeat(43), inviteExpiresAt: now + 300000 }
  }
  const client = {
    isRelay: () => true,
    async request(_method, json) {
      const params = JSON.parse(json)
      return new RpcSuccess('reply', {
        relay,
        installStatus: {
          state: 'committed',
          result: {
            v: 1,
            reqId: params.installReqId,
            currentVersion: 1,
            resumeExpiresAt: now + 86400000,
            authorizationMode: 'relay-basis'
          }
        }
      })
    }
  }
  const meta = {
    id: host.hostIdFor(publicKeyB64),
    name: 'Example desktop',
    endpoint: 'ws://127.0.0.1:6768',
    publicKeyB64,
    lastConnected: 0
  }
  return {
    host,
    pairing,
    offer,
    client,
    meta,
    relay,
    protocol,
    advance: () => {
      now += 1000
      return now
    },
    failJournalRemoval: () => {
      failJournalRemove = true
    }
  }
}

test('removing a paired host prevents a committed but uncleared pairing journal from restoring its trust', async () => {
  const { host, pairing, offer, client, meta, advance, failJournalRemoval } = hostStorage()
  const prepared = await pairing.prepareRelayPairing({}, offer, client)
  failJournalRemoval()
  await assert.rejects(
    pairing.commitRelayPairing({}, meta, 'paired-device-token', prepared),
    /Journal removal failed/
  )
  assert.equal((await host.listHosts({}))[0].id, meta.id)
  advance()
  await host.deleteHost({}, meta.id)
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  await pairing.recoverRelayPairings({})
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  assert.equal(await host.getDeviceToken({}, meta.id), null)
  assert.equal(await host.getRelayCredential({}, meta.id), null)
})

test('a direct pairing started before removal cannot restore the removed desktop', async () => {
  const { host, meta, advance } = hostStorage()
  const startedAt = advance()
  await host.saveHost({}, meta, 'old-device-token', undefined, startedAt)
  advance()
  await host.deleteHost({}, meta.id)
  await assert.rejects(
    host.saveHost({}, meta, 'old-device-token', undefined, startedAt),
    /superseded/
  )
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  assert.equal(await host.getDeviceToken({}, meta.id), null)
})

test('a late relay credential writer cannot overwrite credentials from a newer pairing', async () => {
  const { host, pairing, offer, client, meta, relay, protocol, advance } = hostStorage()
  const prepared = await pairing.prepareRelayPairing({}, offer, client)
  await pairing.commitRelayPairing({}, meta, 'paired-device-token', prepared)
  const old = await host.getRelayCredential({}, meta.id)
  const oldFence = { deviceToken: 'paired-device-token', hash: old.hash, version: old.version }
  advance()
  await host.deleteHost({}, meta.id)
  const startedAt = advance()
  const fresh = {
    token: 'F'.repeat(43),
    hash: protocol.relayCredentialHash('F'.repeat(43)),
    version: 8,
    expiresAt: startedAt + 86400000
  }
  await host.saveHost({}, { ...meta, relay }, 'new-device-token', fresh, startedAt)
  const staleRotation = {
    token: 'O'.repeat(43),
    hash: protocol.relayCredentialHash('O'.repeat(43)),
    version: 2,
    expiresAt: startedAt + 86400000
  }
  await assert.rejects(
    host.updateRelayCredential({}, meta.id, staleRotation, undefined, oldFence),
    /superseded/
  )
  assert.equal(await host.getDeviceToken({}, meta.id), 'new-device-token')
  assert.equal((await host.getRelayCredential({}, meta.id)).token, 'F'.repeat(43))
})

test('a running supervisor dials the durable relay credential instead of an obsolete in-memory token', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const now = 1800000000000
  const credentials = []
  let reconnecting
  const retryScheduled = new Promise((resolve) => {
    reconnecting = resolve
  })
  let connected
  const established = new Promise((resolve) => {
    connected = resolve
  })
  class Client {
    constructor() {
      this.relay = null
    }
    setFflate() {}
    setLogSink() {}
    onSocketClosed(callback) {
      this.closed = callback
    }
    configureRelay(options) {
      this.relay = options
    }
    async connect() {
      if (!this.relay) {
        throw new Error('Desktop LAN unavailable')
      }
      credentials.push(this.relay.credential)
    }
    isRelay() {
      return this.relay !== null
    }
    getRelayCloseCode() {
      return 0
    }
    authenticationRejected() {
      return false
    }
    getResumeConfirmation() {
      return null
    }
    close() {
      this.closed?.()
    }
  }
  const durable = {
    token: 'fresh-durable-token',
    hash: 'fresh-hash',
    version: 8,
    expiresAt: now + 30 * 86400000
  }
  const { HostSession } = loadArkts('transport/HostSession.ets', ['HostSession'], {
    SpikeRpcClient: Client,
    fflateModule: {},
    settleRuntimeCapabilities: async () => {},
    getDeviceToken: async () => 'device-token',
    getRelayCredential: async () => ({ ...durable }),
    relayConnectUrl: () => 'wss://relay.example',
    Date: { now: () => now }
  })
  const session = new HostSession(
    {
      id: 'host',
      name: 'Desktop',
      endpoint: 'ws://unreachable',
      publicKeyB64: 'key',
      relay: { cellUrl: 'https://relay.example', relayHostId: 'relay' }
    },
    'device-token',
    { token: 'obsolete-token', hash: 'old-hash', version: 1, expiresAt: now + 30 * 86400000 },
    {}
  )
  session.addListener((phase) => {
    if (phase === 'reconnecting') {
      reconnecting()
    }
    if (phase === 'connected') {
      connected()
    }
  })
  session.start()
  await retryScheduled
  t.mock.timers.tick(0)
  await established
  assert.deepEqual(credentials, ['fresh-durable-token'])
  session.stop()
})
