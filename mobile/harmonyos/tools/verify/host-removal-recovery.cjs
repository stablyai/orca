const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { loadArkts, util } = require('./arkts-source.cjs')
const { readHostMachineDescriptor } = loadArkts(
  'storage/HostMachine.ets',
  ['readHostMachineDescriptor'],
  { upstream: require('../../entry/src/main/ets/vendor/host-machine.js') }
)

function hostStorage() {
  let now = 1800000000000
  let failJournalRemove = false
  let failJournalWrite = false
  let recoveryDial
  let randomSequence = 0
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
  const journals = new Map()
  class DeviceRowStore {
    constructor(_context, id) {
      this.id = id
    }
    async readPairingJournal() {
      return journals.get(this.id) ?? null
    }
    async writePairingJournal(value) {
      if (failJournalWrite) {
        failJournalWrite = false
        throw new Error('Journal write interrupted')
      }
      journals.set(this.id, value)
    }
    async deletePairingJournal() {
      journals.delete(this.id)
    }
  }
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
      'updateHostMachine',
      'updateHostNameAndEndpoint',
      'hostRemovalTimestamp',
      'hostPairingTimestamp',
      'readHostPairingJournal',
      'writeHostPairingJournal',
      'listHostPairingJournals',
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
      DeviceRowStore,
      readHostMachineDescriptor,
      Date: clock
    }
  )
  class RpcSuccess {
    constructor(id, result) {
      this.id = id
      this.result = JSON.stringify(result)
    }
  }
  const openPairing = () =>
    loadArkts(
      'transport/RelayPairing.ets',
      ['beginRelayPairing', 'prepareRelayPairing', 'commitRelayPairing', 'recoverRelayPairings'],
      {
        ...protocol,
        ...host,
        randomBytes: (length) => new Uint8Array(length).fill(++randomSequence),
        RpcSuccess,
        PairingConnection: class {
          connectRecoveryRelay(...args) {
            return recoveryDial(...args)
          }
          close() {}
        },
        RELAY_PAIRING_CREDENTIAL_REJECTED: 'relay rejected the pairing credential',
        Date: clock
      }
    )
  const pairing = openPairing()
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
    endpoint: 'ws://127.0.0.1:6768',
    publicKeyB64,
    deviceToken: 'paired-device-token',
    relay: { ...relay, inviteToken: 'I'.repeat(43), inviteExpiresAt: now + 300000 }
  }
  const installResult = (reqId) => ({
    v: 1,
    reqId,
    currentVersion: 1,
    resumeExpiresAt: 1800086400000,
    authorizationMode: 'relay-basis'
  })
  const status = (reqId, result, resumeConfirmation) =>
    new RpcSuccess('reply', {
      v: 1,
      relay,
      installStatus: result
        ? { v: 1, reqId, state: 'committed', result }
        : { v: 1, reqId, state: 'not-found' },
      resumeConfirmation
    })
  const client = {
    isRelay: () => true,
    async request(method, json) {
      assert.equal(method, 'pairing.getEndpoints')
      const { installReqId } = JSON.parse(json)
      return status(installReqId, installResult(installReqId))
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
    openPairing,
    status,
    installResult,
    installedReply: (result) => new RpcSuccess('install', result),
    onRecoveryDial: (dial) => {
      recoveryDial = dial
    },
    failJournalWrite: () => {
      failJournalWrite = true
    },
    seedLegacyJournal: (journal) => {
      records.set(`orca.relay.pair.${meta.id}`, utf8Encode(JSON.stringify(journal)))
      getPreferences({}, { name: 'orca_relay_pairing' }).putSync(
        'pending',
        JSON.stringify([meta.id])
      )
    },
    advance: () => {
      now += 1000
      return now
    },
    failJournalRemoval: () => {
      failJournalRemove = true
    }
  }
}

const active = () => true

test('interrupted relay installation and confirmation recover with the same install and a fresh socket proof', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, status, installResult } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  assert.equal((await host.readHostPairingJournal({}, meta.id)).draft.endpoint, offer.endpoint)
  let committed
  await assert.rejects(
    pairing.prepareRelayPairing(
      {},
      journal,
      meta,
      {
        async request(method, raw) {
          const args = JSON.parse(raw)
          if (method === 'pairing.getEndpoints') {
            return status(args.installReqId, null)
          }
          assert.equal(method, 'pairing.provisionRelay')
          assert.equal(args.reqId, journal.reqId)
          assert.equal(args.newResumeTokenHash, journal.hash)
          committed = installResult(args.reqId)
          throw new Error('Response lost after install')
        }
      },
      active
    ),
    /Response lost/
  )
  assert.equal((await host.listHosts({})).length, 0)
  const proofs = []
  fixture.onRecoveryDial(async (_offer, _relay, kind, token) => {
    assert.equal(kind, 'resume')
    assert.equal(token, journal.token)
    return {
      getRelayAcceptedVersion: () => 1,
      async request(method, raw) {
        assert.equal(method, 'pairing.getEndpoints')
        const { installReqId, resumeConfirmReqId } = JSON.parse(raw)
        assert.equal(installReqId, journal.reqId)
        proofs.push(resumeConfirmReqId)
        return status(installReqId, committed, {
          v: 1,
          reqId: resumeConfirmReqId,
          currentVersion: 1,
          acceptedAs: 'current',
          renewed: true,
          resumeExpiresAt: 1800172800000
        })
      }
    }
  })
  fixture.failJournalWrite()
  assert.deepEqual(Array.from(await fixture.openPairing().recoverRelayPairings({})), [])
  assert.equal((await host.listHosts({})).length, 0)
  assert.deepEqual(Array.from(await fixture.openPairing().recoverRelayPairings({})), [meta.id])
  assert.equal(new Set(proofs).size, 2)
  assert.equal((await host.listHosts({}))[0].name, 'Example desktop')
  assert.equal((await host.getRelayCredential({}, meta.id)).expiresAt, 1800172800000)
  assert.equal(await host.readHostPairingJournal({}, meta.id), null)
})

test('invite recovery retries the original install only after an authenticated not-found reply', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, status, installResult, installedReply } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  let disconnected = true
  let installed = null
  fixture.onRecoveryDial(async (_offer, _relay, kind) => {
    if (kind === 'resume') {
      throw new Error('relay rejected the pairing credential')
    }
    return {
      isRelay: () => true,
      async request(method, raw) {
        const args = JSON.parse(raw)
        if (method === 'pairing.getEndpoints') {
          return disconnected ? { errorCode: 'closed' } : status(args.installReqId, installed)
        }
        assert.equal(method, 'pairing.provisionRelay')
        assert.equal(disconnected, false)
        assert.deepEqual(args, { reqId: journal.reqId, newResumeTokenHash: journal.hash })
        installed = installResult(args.reqId)
        return installedReply(installed)
      }
    }
  })
  assert.deepEqual(Array.from(await fixture.openPairing().recoverRelayPairings({})), [])
  assert.equal((await host.readHostPairingJournal({}, meta.id)).reqId, journal.reqId)
  disconnected = false
  assert.deepEqual(Array.from(await fixture.openPairing().recoverRelayPairings({})), [meta.id])
  assert.equal((await host.getRelayCredential({}, meta.id)).hash, journal.hash)
})

test('removing a desktop while invite recovery checks its status prevents a new remote install', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, status } = fixture
  await host.saveHost({}, meta, 'existing-token', undefined, advance())
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  let requestStarted
  const waiting = new Promise((resolve) => {
    requestStarted = resolve
  })
  let resolveStatus
  const pending = new Promise((resolve) => {
    resolveStatus = resolve
  })
  const requests = []
  fixture.onRecoveryDial(async (_offer, _relay, kind) => {
    if (kind === 'resume') {
      throw new Error('relay rejected the pairing credential')
    }
    return {
      async request(method) {
        requests.push(method)
        requestStarted()
        return pending
      }
    }
  })
  const recovery = fixture.openPairing().recoverRelayPairings({})
  await waiting
  advance()
  await host.deleteHost({}, meta.id)
  resolveStatus(status(journal.reqId, null))
  assert.deepEqual(Array.from(await recovery), [])
  assert.deepEqual(requests, ['pairing.getEndpoints'])
  assert.equal((await host.listHosts({})).length, 0)
  assert.equal(await host.readHostPairingJournal({}, meta.id), null)
})

test('a committed pairing journal from the Asset Store remains recoverable after upgrade', async () => {
  const { host, pairing, meta, offer, relay, protocol, seedLegacyJournal, advance } = hostStorage()
  const token = 'T'.repeat(43)
  const hash = protocol.relayCredentialHash(token)
  seedLegacyJournal({
    startedAt: advance(),
    reqId: 'old-install',
    token,
    hash,
    offerKey: offer.publicKeyB64,
    deviceToken: 'legacy-token',
    committedMeta: { ...meta, relay },
    credential: { token, hash, version: 2, expiresAt: 1800086400000 }
  })
  assert.deepEqual(Array.from(await pairing.recoverRelayPairings({})), [meta.id])
  assert.equal(await host.getDeviceToken({}, meta.id), 'legacy-token')
  assert.equal((await host.getRelayCredential({}, meta.id)).version, 2)
  assert.equal(await host.readHostPairingJournal({}, meta.id), null)
})

test('removing a paired host prevents a committed but uncleared pairing journal from restoring its trust', async () => {
  const { host, pairing, offer, client, meta, advance, failJournalRemoval } = hostStorage()
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  const prepared = await pairing.prepareRelayPairing({}, journal, meta, client, active)
  failJournalRemoval()
  await pairing.commitRelayPairing({}, meta, 'paired-device-token', prepared, active)
  assert.equal((await host.listHosts({}))[0].id, meta.id)
  assert.equal((await host.readHostPairingJournal({}, meta.id)).committedMeta.id, meta.id)
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

test('desktop machine details survive a host-list reload and stale status cannot cross a pairing', async () => {
  const { host, meta, advance } = hostStorage()
  const first = { ...meta, lastConnected: advance() }
  await host.saveHost({}, first, 'first-device-token', undefined, first.lastConnected)
  await host.updateHostNameAndEndpoint({}, first.id, 'My desktop', first.endpoint)
  await host.updateHostMachine({}, first, {
    hostPlatform: 'darwin',
    hostMachine: { kind: 'desktop', model: 'Mac mini' }
  })
  const [held] = await host.listHosts({})
  assert.equal(held.name, 'My desktop')
  assert.equal(held.hostPlatform, 'darwin')
  assert.equal(held.hostMachine.kind, 'desktop')
  assert.equal(held.hostMachine.model, 'Mac mini')

  const second = { ...meta, lastConnected: advance(), hostPlatform: 'linux' }
  await host.saveHost({}, second, 'second-device-token', undefined, second.lastConnected)
  await host.updateHostMachine({}, first, {
    hostPlatform: 'darwin',
    hostMachine: { kind: 'laptop', model: 'MacBook Pro' }
  })
  const [repaired] = await host.listHosts({})
  assert.equal(repaired.name, 'My desktop')
  assert.equal(repaired.hostPlatform, 'linux')
  assert.equal(repaired.hostMachine, undefined)
})

test('a late relay credential writer cannot overwrite credentials from a newer pairing', async () => {
  const { host, pairing, offer, client, meta, relay, protocol, advance } = hostStorage()
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  const prepared = await pairing.prepareRelayPairing({}, journal, meta, client, active)
  await pairing.commitRelayPairing({}, meta, 'paired-device-token', prepared, active)
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
    getDeadlineFailure() {
      return ''
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
  const { RelayHostReachability } = loadArkts(
    'diagnostics/ConnectionDiagnostics.ets',
    ['RelayHostReachability'],
    {
      upstream: require('../../entry/src/main/ets/vendor/connection-diagnostics.js'),
      url: { URL },
      utf8Encode: (text) => new TextEncoder().encode(text)
    }
  )
  const { HostSession } = loadArkts('transport/HostSession.ets', ['HostSession'], {
    SpikeRpcClient: Client,
    RelayHostReachability,
    directPath: () => 'lan',
    appendLog: async () => {},
    LOG_LEVEL_INFO: 'info',
    LOG_LEVEL_SUCCESS: 'success',
    LOG_LEVEL_WARN: 'warn',
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
