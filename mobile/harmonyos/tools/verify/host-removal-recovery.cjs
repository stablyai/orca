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
  let failTokenRemove = false
  let failPageRemove = false
  let failHostFlush = false
  let waitAfterTokenUpdate
  let waitBeforeTokenRemoval
  let recoveryDial
  let randomSequence = 0
  let exchangeSequence = 0xaa
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
      const key = alias(query)
      records.set(key, value.get(tag.SECRET))
      if (waitAfterTokenUpdate && key.startsWith('orca.token.')) {
        const wait = waitAfterTokenUpdate
        waitAfterTokenUpdate = undefined
        await wait()
      }
    },
    async remove(query) {
      const key = alias(query)
      if (key.startsWith('orca.token.') && waitBeforeTokenRemoval) {
        const wait = waitBeforeTokenRemoval
        waitBeforeTokenRemoval = undefined
        await wait()
      }
      if (key.startsWith('orca.token.') && failTokenRemove) {
        failTokenRemove = false
        throw new Error('Asset Store temporarily unavailable')
      }
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
      getAllSync() {
        return Object.fromEntries(stored)
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
      flushSync() {
        if (name === 'orca_hosts' && failHostFlush) {
          failHostFlush = false
          throw new Error('Host preference flush failed')
        }
      }
    }
  }
  const preferences = {
    getPreferences: async (...args) => getPreferences(...args),
    getPreferencesSync: getPreferences
  }
  const openHost = () =>
    loadArkts(
      'storage/HostStore.ets',
      [
        'hostIdFor',
        'saveHost',
        'deleteHost',
        'loadPendingHostCredentialCleanup',
        'retryPendingHostCredentialCleanup',
        'listHosts',
        'getDeviceToken',
        'getRelayCredential',
        'updateRelayCredential',
        'updateHostMachine',
        'updateHostNameAndEndpoint',
        'hostRemovalTimestamp',
        'hostPairingTimestamp',
        'hostPairingCancellationTimestamp',
        'cancelHostPairing',
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
        clearHomeResume: () => {},
        deletePageStorage: async () => {
          if (failPageRemove) {
            failPageRemove = false
            throw new Error('Page storage temporarily unavailable')
          }
        },
        readHostMachineDescriptor,
        Date: clock
      }
    )
  const host = openHost()
  class RpcSuccess {
    constructor(id, result) {
      this.id = id
      this.result = JSON.stringify(result)
    }
  }
  const { exchangePairingTicket } = loadArkts(
    'pairing/PairingConnection.ets',
    ['exchangePairingTicket'],
    {
      RpcSuccess,
      randomBytes: (length) => new Uint8Array(length).fill(++exchangeSequence),
      toHex: (value) => Buffer.from(value).toString('hex')
    }
  )
  const openPairing = () =>
    loadArkts(
      'transport/RelayPairing.ets',
      [
        'beginRelayPairing',
        'cancelRelayPairing',
        'finishRelayPairing',
        'exchangeJournalTicket',
        'prepareRelayPairing',
        'commitRelayPairing',
        'recoverRelayPairings'
      ],
      {
        ...protocol,
        ...host,
        exchangePairingTicket,
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
    onTokenUpdate(wait) {
      waitAfterTokenUpdate = wait
    },
    onTokenRemoval(wait) {
      waitBeforeTokenRemoval = wait
    },
    host,
    openHost,
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
    },
    failTokenRemoval: () => {
      failTokenRemove = true
    },
    failPageRemoval: () => {
      failPageRemove = true
    },
    failHostFlush: () => {
      failHostFlush = true
    }
  }
}

const active = () => true

function confirmedResumeClient(fixture) {
  return {
    getRelayAcceptedVersion: () => 1,
    async request(method, raw) {
      assert.equal(method, 'pairing.getEndpoints')
      const { installReqId, resumeConfirmReqId } = JSON.parse(raw)
      return fixture.status(installReqId, fixture.installResult(installReqId), {
        v: 1,
        reqId: resumeConfirmReqId,
        currentVersion: 1,
        acceptedAs: 'current',
        renewed: true,
        resumeExpiresAt: 1800172800000
      })
    }
  }
}

test('an explicitly cancelled pairing stays unpaired after process restart', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  await pairing.cancelRelayPairing({}, meta.id, journal.startedAt)
  pairing.finishRelayPairing(meta.id, journal.startedAt)
  fixture.onRecoveryDial(async () => confirmedResumeClient(fixture))

  await fixture.openPairing().recoverRelayPairings({})
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  assert.equal(await host.getDeviceToken({}, meta.id), null)
  assert.equal(await host.getRelayCredential({}, meta.id), null)
})

test('a failed journal update cannot turn an explicit cancellation into restart recovery', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, failJournalWrite } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  failJournalWrite()
  await assert.rejects(
    pairing.cancelRelayPairing({}, meta.id, journal.startedAt),
    /Journal write interrupted/
  )
  pairing.finishRelayPairing(meta.id, journal.startedAt)
  fixture.onRecoveryDial(async () => confirmedResumeClient(fixture))

  await fixture.openPairing().recoverRelayPairings({})
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  assert.equal(await host.getDeviceToken({}, meta.id), null)
})

test('cancelling an in-flight install prevents recovery until an explicit retry reconciles it', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, installedReply, installResult, status } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  const installing = Promise.withResolvers()
  const installed = Promise.withResolvers()
  let allowed = true
  const preparing = pairing.prepareRelayPairing(
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
        installing.resolve()
        return installed.promise
      }
    },
    () => allowed
  )
  await installing.promise
  allowed = false
  await pairing.cancelRelayPairing({}, meta.id, journal.startedAt)
  pairing.finishRelayPairing(meta.id, journal.startedAt)
  installed.resolve(installedReply(installResult(journal.reqId)))
  await assert.rejects(preparing, /cancelled/)
  fixture.onRecoveryDial(async () => confirmedResumeClient(fixture))
  const restarted = fixture.openPairing()
  await restarted.recoverRelayPairings({})
  assert.deepEqual(Array.from(await host.listHosts({})), [])

  const retry = await restarted.beginRelayPairing({}, offer, advance(), active)
  const prepared = await restarted.prepareRelayPairing(
    {},
    retry,
    meta,
    {
      async request(method, raw) {
        assert.equal(method, 'pairing.getEndpoints')
        assert.equal(JSON.parse(raw).installReqId, journal.reqId)
        return status(journal.reqId, installResult(journal.reqId))
      }
    },
    active
  )
  await restarted.commitRelayPairing({}, meta, 'paired-device-token', prepared, active)
  assert.equal(await host.getDeviceToken({}, meta.id), 'paired-device-token')
  assert.equal((await host.getRelayCredential({}, meta.id)).token, journal.token)
})

test('cancelling committed-journal recovery during credential storage preserves the existing pairing', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, client, meta, advance, failHostFlush, onTokenUpdate } = fixture
  await host.saveHost({}, meta, 'existing-device-token', undefined, advance())
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  const prepared = await pairing.prepareRelayPairing({}, journal, meta, client, active)
  failHostFlush()
  await assert.rejects(
    pairing.commitRelayPairing({}, meta, 'replacement-device-token', prepared, active),
    /Host preference flush failed/
  )
  const updating = Promise.withResolvers()
  const continueUpdate = Promise.withResolvers()
  onTokenUpdate(() => {
    updating.resolve()
    return continueUpdate.promise
  })
  const restarted = fixture.openPairing()
  const recovery = restarted.recoverRelayPairings({})
  await updating.promise
  const cancelled = restarted.cancelRelayPairing({}, meta.id, journal.startedAt)
  continueUpdate.resolve()
  await cancelled
  await recovery
  assert.equal(await host.getDeviceToken({}, meta.id), 'existing-device-token')
  assert.equal(await host.getRelayCredential({}, meta.id), null)
  await fixture.openPairing().recoverRelayPairings({})
  assert.equal(await host.getDeviceToken({}, meta.id), 'existing-device-token')
})

test('a lost direct exchange reply preserves its candidate before RPC and reuses it after restart', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, meta, advance, installedReply } = fixture
  const directOffer = { ...offer, relay: undefined }
  const journal = await pairing.beginRelayPairing({}, directOffer, advance(), active)
  const replacement = 'abababababababababababababababababababababababab'
  await assert.rejects(
    pairing.exchangeJournalTicket(
      {},
      journal,
      {
        status: { capabilities: ['pairing.ticket-exchange.v1'] },
        client: {
          async request(method, raw) {
            assert.equal(method, 'pairing.exchangeTicket')
            assert.equal(JSON.parse(raw).deviceToken, replacement)
            assert.equal(
              (await host.readHostPairingJournal({}, meta.id)).replacementToken,
              replacement
            )
            throw new Error('Reply lost after ticket exchange')
          }
        }
      },
      () => {},
      active
    ),
    /Reply lost after ticket exchange/
  )
  assert.deepEqual(Array.from(await host.listHosts({})), [])
  const restarted = fixture.openPairing()
  const retry = await restarted.beginRelayPairing({}, directOffer, advance(), active)
  const token = await restarted.exchangeJournalTicket(
    {},
    retry,
    {
      status: { capabilities: ['pairing.ticket-exchange.v1'] },
      client: {
        async request(method, raw) {
          assert.equal(method, 'pairing.exchangeTicket')
          assert.equal(JSON.parse(raw).deviceToken, replacement)
          return installedReply({ deviceId: 'confirmed-device' })
        }
      }
    },
    () => {},
    active
  )
  await host.saveHost({}, meta, token, undefined, retry.startedAt, false, retry, active)
  assert.equal(await host.getDeviceToken({}, meta.id), replacement)
})

test('relay recovery reconciles a lost ticket exchange before publishing its credential', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, client, meta, advance, installedReply } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  await pairing.prepareRelayPairing({}, journal, meta, client, active)
  const replacement = 'abababababababababababababababababababababababab'
  await assert.rejects(
    pairing.exchangeJournalTicket(
      {},
      journal,
      {
        status: { capabilities: ['pairing.ticket-exchange.v1'] },
        client: {
          request: async () => {
            throw new Error('Exchange reply lost')
          }
        }
      },
      () => {},
      active
    ),
    /Exchange reply lost/
  )
  fixture.onRecoveryDial(async () => {
    const confirmed = confirmedResumeClient(fixture)
    return {
      ...confirmed,
      async request(method, raw) {
        if (method === 'status.get') {
          return installedReply({ capabilities: ['pairing.ticket-exchange.v1'] })
        }
        if (method === 'pairing.exchangeTicket') {
          assert.equal(JSON.parse(raw).deviceToken, replacement)
          return installedReply({ deviceId: 'confirmed-device' })
        }
        return confirmed.request(method, raw)
      }
    }
  })
  await fixture.openPairing().recoverRelayPairings({})
  assert.deepEqual(
    Array.from(await host.listHosts({})).map((item) => item.name),
    ['Example desktop']
  )
  assert.equal(await host.getDeviceToken({}, meta.id), replacement)
  assert.equal((await host.getRelayCredential({}, meta.id)).expiresAt, 1800172800000)
})

test('a rescan reuses the ticket candidate when recovery replay succeeds but install confirmation is lost', async () => {
  const fixture = hostStorage()
  const { host, pairing, offer, client, meta, advance, installedReply } = fixture
  const journal = await pairing.beginRelayPairing({}, offer, advance(), active)
  await pairing.prepareRelayPairing({}, journal, meta, client, active)
  const replacement = 'abababababababababababababababababababababababab'
  await assert.rejects(
    pairing.exchangeJournalTicket(
      {},
      journal,
      {
        status: { capabilities: ['pairing.ticket-exchange.v1'] },
        client: {
          request: async () => {
            throw new Error('Exchange reply lost')
          }
        }
      },
      () => {},
      active
    ),
    /Exchange reply lost/
  )
  fixture.onRecoveryDial(async () => ({
    async request(method, raw) {
      if (method === 'status.get') {
        return installedReply({ capabilities: ['pairing.ticket-exchange.v1'] })
      }
      if (method === 'pairing.exchangeTicket') {
        assert.equal(JSON.parse(raw).deviceToken, replacement)
        return installedReply({ deviceId: 'confirmed-device' })
      }
      throw new Error('Install confirmation reply lost')
    }
  }))
  await fixture.openPairing().recoverRelayPairings({})
  assert.deepEqual(Array.from(await host.listHosts({})), [])

  const restarted = fixture.openPairing()
  const retry = await restarted.beginRelayPairing({}, offer, advance(), active)
  const token = await restarted.exchangeJournalTicket(
    {},
    retry,
    {
      status: { capabilities: ['pairing.ticket-exchange.v1'] },
      client: {
        async request(method, raw) {
          assert.equal(method, 'pairing.exchangeTicket')
          assert.equal(JSON.parse(raw).deviceToken, replacement)
          return installedReply({ deviceId: 'confirmed-device' })
        }
      }
    },
    () => {},
    active
  )
  const prepared = await restarted.prepareRelayPairing({}, retry, meta, client, active)
  await restarted.commitRelayPairing({}, meta, token, prepared, active)
  assert.equal(await host.getDeviceToken({}, meta.id), replacement)
})

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

test('cancelled direct re-pair restores the existing host and credential before publication', async () => {
  const { host, meta, advance, onTokenUpdate } = hostStorage()
  const firstPairing = advance()
  await host.saveHost({}, meta, 'existing-device-token', undefined, firstPairing)
  let allowed = true
  const updated = Promise.withResolvers()
  const resume = Promise.withResolvers()
  onTokenUpdate(() => {
    updated.resolve()
    return resume.promise
  })
  const replacement = host.saveHost(
    {},
    { ...meta, endpoint: 'ws://127.0.0.1:6769' },
    'replacement-device-token',
    undefined,
    advance(),
    false,
    undefined,
    () => allowed
  )
  await updated.promise
  allowed = false
  resume.resolve()
  await assert.rejects(replacement, /Pairing was cancelled/)
  assert.equal((await host.listHosts({}))[0].endpoint, 'ws://127.0.0.1:6768')
  assert.equal(await host.getDeviceToken({}, meta.id), 'existing-device-token')
  assert.equal(host.hostPairingTimestamp({}, meta.id), firstPairing)
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
  await host.retryPendingHostCredentialCleanup({})
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
  await host.retryPendingHostCredentialCleanup({})
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
  await host.retryPendingHostCredentialCleanup({})
  assert.equal(await host.getDeviceToken({}, meta.id), null)
})

test('a removed desktop stays removed across restart when credential deletion fails', async () => {
  const { host, openHost, meta, relay, protocol, advance, failTokenRemoval } = hostStorage()
  const startedAt = advance()
  const token = 'T'.repeat(43)
  await host.saveHost(
    {},
    { ...meta, relay },
    'previous-device-token',
    {
      token,
      hash: protocol.relayCredentialHash(token),
      version: 1,
      expiresAt: startedAt + 86400000
    },
    startedAt
  )
  advance()
  failTokenRemoval()
  await host.deleteHost({}, meta.id)
  assert.equal((await host.retryPendingHostCredentialCleanup({})).count, 1)

  const restarted = openHost()
  assert.deepEqual(Array.from(await restarted.listHosts({})), [])
  assert.equal((await restarted.loadPendingHostCredentialCleanup({})).count, 1)
  assert.equal((await restarted.retryPendingHostCredentialCleanup({})).count, 0)
  assert.equal(await restarted.getDeviceToken({}, meta.id), null)
  assert.equal(await restarted.getRelayCredential({}, meta.id), null)
})

test('credential cleanup preserves a newer unpublished Relay journal', async () => {
  const { host, pairing, offer, client, meta, advance, failPageRemoval } = hostStorage()
  await host.saveHost({}, meta, 'previous-device-token', undefined, advance())
  advance()
  await host.deleteHost({}, meta.id)
  failPageRemoval()
  assert.equal((await host.retryPendingHostCredentialCleanup({})).count, 1)

  const replacement = await pairing.beginRelayPairing({}, offer, advance(), active)
  assert.equal((await host.retryPendingHostCredentialCleanup({})).count, 0)
  assert.equal((await host.readHostPairingJournal({}, meta.id)).reqId, replacement.reqId)
  const prepared = await pairing.prepareRelayPairing({}, replacement, meta, client, active)
  await pairing.commitRelayPairing({}, meta, 'replacement-device-token', prepared, active)
  await host.retryPendingHostCredentialCleanup({})
  assert.equal(await host.getDeviceToken({}, meta.id), 'replacement-device-token')
})

test('a failed removal commit preserves the original pairing and leaves no cleanup intent', async () => {
  const { host, meta, advance, failHostFlush } = hostStorage()
  await host.saveHost({}, meta, 'previous-device-token', undefined, advance())
  advance()
  failHostFlush()
  await assert.rejects(host.deleteHost({}, meta.id), /preference flush failed/)
  assert.equal((await host.listHosts({}))[0].id, meta.id)
  assert.equal(host.hostRemovalTimestamp({}, meta.id), 0)
  assert.equal((await host.retryPendingHostCredentialCleanup({})).count, 0)
  assert.equal(await host.getDeviceToken({}, meta.id), 'previous-device-token')
})

test('a replacement pairing survives an older credential delete still running in the Asset Store', async () => {
  const { host, meta, advance, onTokenRemoval } = hostStorage()
  await host.saveHost({}, meta, 'previous-device-token', undefined, advance())
  advance()
  await host.deleteHost({}, meta.id)

  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  onTokenRemoval(() => {
    started.resolve()
    return finish.promise
  })
  const cleaning = host.retryPendingHostCredentialCleanup({})
  await started.promise
  const repairing = host.saveHost({}, meta, 'replacement-device-token', undefined, advance())
  await new Promise((resolve) => setImmediate(resolve))
  finish.resolve()
  await Promise.all([cleaning, repairing])

  assert.equal((await host.listHosts({}))[0].id, meta.id)
  assert.equal((await host.loadPendingHostCredentialCleanup({})).count, 0)
  assert.equal(await host.getDeviceToken({}, meta.id), 'replacement-device-token')
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

test('desktop edits preserve fields changed since the editor opened', async () => {
  const { host, meta, advance } = hostStorage()
  await host.saveHost({}, { ...meta }, 'first-device-token', undefined, advance())
  await host.saveHost(
    {},
    { ...meta, name: 'Repaired desktop', endpoint: 'ws://repaired.invalid:6768' },
    'second-device-token',
    undefined,
    advance()
  )

  const nameOnly = await host.updateHostNameAndEndpoint({}, meta.id, 'My desktop')
  const [renamed] = await host.listHosts({})
  assert.equal(nameOnly, false)
  assert.equal(renamed.name, 'My desktop')
  assert.equal(renamed.endpoint, 'ws://repaired.invalid:6768')

  const endpointOnly = await host.updateHostNameAndEndpoint(
    {},
    meta.id,
    undefined,
    'ws://edited.invalid:6768'
  )
  assert.equal(endpointOnly, true)
  assert.equal((await host.listHosts({}))[0].name, 'My desktop')

  const resetName = await host.updateHostNameAndEndpoint(
    {},
    meta.id,
    '',
    'ws://edited.invalid:6768'
  )
  const [reset] = await host.listHosts({})
  assert.equal(resetName, false)
  assert.equal(reset.name, 'Repaired desktop')
  assert.equal(reset.endpoint, 'ws://edited.invalid:6768')
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
