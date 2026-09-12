import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareOutgoingOrcadSource } from './orcad-outgoing-source-preparation'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { OrcadOutgoingPreparationConnectionStore } from './orcad-outgoing-preparation-connection'
import { OrcadOutgoingPreparationDrainReceiptStore } from './orcad-outgoing-preparation-drain-receipt'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation,
  context,
  makeDelegatedRelay
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import * as secure from '../../shared/secure-file'

const registry = vi.hoisted(() => ({ provider: vi.fn(), route: vi.fn() }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getSshPtyProvider: registry.provider,
  getProviderForPty: registry.route
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-prep-source-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const model = createOrcadModelImportFixture(root)
  const store = new OrcadOutgoingPreparationStore(root)
  const hostStore = new RelayPtyOwnershipTransferFileStore(join(root, 'rpc-source'))
  const host = makeDelegatedRelay(hostStore)
  const provider = {
    providerGeneration: 1,
    drainOutgoingSourceControls: vi.fn(async () => {}),
    getOwnershipTransferSourceIdentity: () => identity,
    getOwnershipBridgeCapabilities: vi.fn(async () => ({
      liveTransfer: true,
      statusQuery: true,
      preparationShutdownGuardVersion: 1,
      transferGraceGuardVersion: 1,
      transferLifecycleGuardVersion: 1,
      destinationDelegationVersion: 1,
      captureBoundaryVersion: 1,
      captureSelectionVersion: 1
    })),
    requestHostRpc: vi.fn(async (method: string, params: unknown) => {
      expect(new OrcadOutgoingPreparationStore(root).read(identity)).not.toBeNull()
      expect(new OrcadOutgoingPreparationDrainReceiptStore(root).read(identity)).toMatchObject({
        ...new OrcadOutgoingPreparationConnectionStore(root).read(identity),
        kind: 'mux-control-drain',
        scope: 'bound-mux-lifetime'
      })
      if (method === 'pty.ownershipTransfer.status') {
        return host.status(params)
      }
      if (method === 'pty.ownershipTransfer.recoverDestination') {
        return host.recoverDestination(params, context())
      }
      expect(method).toBe('pty.ownershipTransfer.prepare')
      return host.prepare(params)
    })
  }
  registry.provider.mockReturnValue(provider)
  registry.route.mockReturnValue(provider)
  const options = {
    store,
    ptyId: `ssh:source@@${identity.terminalId}`,
    signal: new AbortController().signal,
    assertAuthority: vi.fn(),
    preparation: {
      version: 1,
      kind: 'preparation',
      identity,
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      source: model.store.loadDelegatedSource(identity),
      surfaceBinding: preparation.surfacePublication.surfaceBinding
    }
  }
  return { options, provider, hostStore, store }
}

it('persists the exact source preparation before host contact and validates the reply', async () => {
  const f = fixture()
  expect(f.hostStore.loadAll()).toEqual([])
  const result = await prepareOutgoingOrcadSource(f.options)
  expect(result.prepared).toMatchObject({
    ...identity,
    phase: 'prepared',
    destinationDelegation: preparation.destinationDelegation
  })
  expect(f.store.read(identity)).toEqual(result.intent)
  expect(f.provider.requestHostRpc).toHaveBeenCalledOnce()
  expect(f.provider.drainOutgoingSourceControls).toHaveBeenCalledWith(
    expect.objectContaining({
      surfaceBinding: result.intent.surfaceBinding
    })
  )
})

it('retains credentials and retries exactly after the source reply is lost', async () => {
  const f = fixture()
  const request = f.provider.requestHostRpc.getMockImplementation()!
  f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => {
    await request(method, params)
    throw new Error('lost reply')
  })
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('lost reply')
  const before = f.hostStore.loadAll()
  const store = new OrcadOutgoingPreparationStore(root)
  await prepareOutgoingOrcadSource({ ...f.options, store, preparation: store.read(identity) })
  expect(f.provider.requestHostRpc.mock.calls[0]).toEqual(f.provider.requestHostRpc.mock.calls[1])
  expect(f.hostStore.loadAll()).toEqual(before)
})

it.each(['before-save', 'after-save'])(
  'explicit recovery repairs %s host preparation uncertainty on the pinned provider',
  async (phase) => {
    const f = fixture()
    const save = f.hostStore.save.bind(f.hostStore)
    vi.spyOn(f.hostStore, 'save').mockImplementationOnce((record) => {
      if (phase === 'after-save') {
        save(record)
      }
      throw new Error('host fsync failed')
    })
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('host fsync failed')
    const connections = new OrcadOutgoingPreparationConnectionStore(root)
    const binding = connections.read(identity)
    const drains = new OrcadOutgoingPreparationDrainReceiptStore(root)
    const drain = drains.read(identity)
    const intent = f.store.read(identity)
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow(
      'pty_ownership_transfer_delegation_write_unverifiable'
    )
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'pty.ownershipTransfer.prepare',
      'pty.ownershipTransfer.prepare'
    ])
    f.provider.requestHostRpc.mockClear()
    await expect(
      prepareOutgoingOrcadSource({ ...f.options, recoverDurability: true })
    ).resolves.toMatchObject({ prepared: { phase: 'prepared' } })
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'pty.ownershipTransfer.prepare',
      'pty.ownershipTransfer.status',
      'pty.ownershipTransfer.recoverDestination',
      'pty.ownershipTransfer.prepare'
    ])
    expect(f.hostStore.loadAll()).toHaveLength(1)
    expect(f.store.read(identity)).toEqual(intent)
    expect(connections.read(identity)).toEqual(binding)
    expect(drains.read(identity)).toEqual(drain)
  }
)

it.each(['capability', 'status-conflict', 'provider-drift', 'transport-error'])(
  'does not recover an uncertain preparation across %s',
  async (failure) => {
    const f = fixture()
    vi.spyOn(f.hostStore, 'save').mockImplementationOnce(() => {
      throw new Error('host fsync failed')
    })
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('host fsync failed')
    const request = f.provider.requestHostRpc.getMockImplementation()!
    if (failure === 'capability') {
      const capabilities = await f.provider.getOwnershipBridgeCapabilities()
      f.provider.getOwnershipBridgeCapabilities.mockResolvedValue({
        ...capabilities,
        statusQuery: false
      })
    }
    f.provider.requestHostRpc.mockImplementation(async (method, params) => {
      if (failure === 'transport-error' && method === 'pty.ownershipTransfer.prepare') {
        throw new Error('connection lost')
      }
      const response = await request(method, params)
      if (method === 'pty.ownershipTransfer.status') {
        if (failure === 'provider-drift') {
          registry.provider.mockReturnValue({ ...f.provider })
        }
        if (failure === 'status-conflict') {
          return {
            ...response,
            destinationDelegation: { version: 1 as const, credentialSha256: '0'.repeat(64) }
          }
        }
      }
      return response
    })
    f.provider.requestHostRpc.mockClear()
    await expect(
      prepareOutgoingOrcadSource({ ...f.options, recoverDurability: true })
    ).rejects.toThrow()
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).not.toContain(
      'pty.ownershipTransfer.recoverDestination'
    )
    expect(f.store.read(identity)).not.toBeNull()
  }
)

it.each(['reply-lost', 'fsync-failed', 'provider-drift', 'claim-conflict'])(
  'preserves preparation evidence after recovery %s and never guesses completion',
  async (failure) => {
    const f = fixture()
    const save = vi.spyOn(f.hostStore, 'save').mockImplementationOnce(() => {
      throw new Error('host fsync failed')
    })
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('host fsync failed')
    const binding = new OrcadOutgoingPreparationConnectionStore(root).read(identity)
    const intent = f.store.read(identity)
    const request = f.provider.requestHostRpc.getMockImplementation()!
    if (failure === 'fsync-failed') {
      save.mockImplementationOnce(() => {
        throw new Error('recovery fsync failed')
      })
    }
    f.provider.requestHostRpc.mockImplementation(async (method, params) => {
      const response = await request(method, params)
      if (method === 'pty.ownershipTransfer.recoverDestination') {
        if (failure === 'reply-lost') {
          throw new Error('recovery reply lost')
        }
        if (failure === 'provider-drift') {
          registry.provider.mockReturnValue({ ...f.provider })
        }
        if (failure === 'claim-conflict') {
          return { ...response, destinationClaim: { generation: 1, claimId: 'existing' } }
        }
      }
      return response
    })
    f.provider.requestHostRpc.mockClear()
    await expect(
      prepareOutgoingOrcadSource({ ...f.options, recoverDurability: true })
    ).rejects.toThrow()
    expect(f.provider.requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'pty.ownershipTransfer.prepare',
      'pty.ownershipTransfer.status',
      'pty.ownershipTransfer.recoverDestination'
    ])
    expect(f.store.read(identity)).toEqual(intent)
    expect(new OrcadOutgoingPreparationConnectionStore(root).read(identity)).toEqual(binding)
    if (failure === 'reply-lost' || failure === 'fsync-failed') {
      f.provider.requestHostRpc.mockImplementation(request)
      await expect(
        prepareOutgoingOrcadSource({ ...f.options, recoverDurability: true })
      ).resolves.toMatchObject({
        prepared: { phase: 'prepared' }
      })
    }
  }
)

it.each(['drain', 'prepare'])(
  'refuses a replacement provider after interrupted %s',
  async (phase) => {
    const f = fixture()
    if (phase === 'drain') {
      f.provider.drainOutgoingSourceControls.mockRejectedValueOnce(new Error('uncertain control'))
    } else {
      f.provider.requestHostRpc.mockRejectedValueOnce(new Error('lost prepare response'))
    }
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow()
    const connections = new OrcadOutgoingPreparationConnectionStore(root)
    const retained = connections.read(identity)
    const receipts = new OrcadOutgoingPreparationDrainReceiptStore(root)
    const retainedDrain = receipts.read(identity)
    expect(retainedDrain !== null).toBe(phase === 'prepare')
    expect(retained).not.toBeNull()
    const replacement = { ...f.provider, providerGeneration: f.provider.providerGeneration }
    registry.provider.mockReturnValue(replacement)
    registry.route.mockReturnValue(replacement)
    f.provider.drainOutgoingSourceControls.mockClear()
    f.provider.requestHostRpc.mockClear()
    const store = new OrcadOutgoingPreparationStore(root)
    await expect(
      prepareOutgoingOrcadSource({
        ...f.options,
        store,
        preparation: store.read(identity)
      })
    ).rejects.toThrow('connection_reconciliation_required')
    expect(f.provider.drainOutgoingSourceControls).not.toHaveBeenCalled()
    expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
    expect(connections.read(identity)).toEqual(retained)
    expect(receipts.read(identity)).toEqual(retainedDrain)
    expect(store.read(identity)).not.toBeNull()
  }
)

it('refuses unbound legacy intent without inventing settled connection evidence', async () => {
  const f = fixture()
  f.store.persist(f.options.preparation)
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow(
    'connection_reconciliation_required'
  )
  expect(f.provider.drainOutgoingSourceControls).not.toHaveBeenCalled()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('retains intent and waits for source control drain before preparing the host', async () => {
  const f = fixture()
  const drain = Promise.withResolvers<void>()
  f.provider.drainOutgoingSourceControls.mockImplementationOnce(() => drain.promise)
  const prepared = prepareOutgoingOrcadSource(f.options)
  await vi.waitFor(() => expect(f.provider.drainOutgoingSourceControls).toHaveBeenCalledOnce())
  expect(f.store.read(identity)).not.toBeNull()
  expect(new OrcadOutgoingPreparationDrainReceiptStore(root).read(identity)).toBeNull()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  drain.resolve()
  await prepared
  expect(f.provider.requestHostRpc).toHaveBeenCalledOnce()
})

it('rechecks durable connection evidence after an asynchronous drain', async () => {
  const f = fixture()
  const drain = Promise.withResolvers<void>()
  f.provider.drainOutgoingSourceControls.mockImplementationOnce(() => drain.promise)
  const prepared = prepareOutgoingOrcadSource(f.options)
  const refused = expect(prepared).rejects.toThrow('connection_reconciliation_required')
  await vi.waitFor(() => expect(f.provider.drainOutgoingSourceControls).toHaveBeenCalledOnce())
  vi.spyOn(OrcadOutgoingPreparationConnectionStore.prototype, 'read').mockReturnValueOnce(null)
  drain.resolve()
  await refused
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(f.store.read(identity)).not.toBeNull()
  expect(new OrcadOutgoingPreparationDrainReceiptStore(root).read(identity)).toBeNull()
})

it('does not prepare or discard intent when source control drain is unverifiable', async () => {
  const f = fixture()
  f.provider.drainOutgoingSourceControls.mockRejectedValueOnce(
    new Error('control outcome unverifiable')
  )
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow(
    'control outcome unverifiable'
  )
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(f.store.read(identity)).not.toBeNull()
  expect(new OrcadOutgoingPreparationDrainReceiptStore(root).read(identity)).toBeNull()
})

it.each(['before-save', 'after-save'])(
  'does not prepare after %s drain receipt failure and reflushes the exact receipt on retry',
  async (phase) => {
    const f = fixture()
    const write = secure.writeDurableSecureJsonFile
    let failDrain = true
    let drainWrites = 0
    vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
      if (String(path).includes('orcad-outgoing-preparation-drains')) {
        drainWrites++
        if (failDrain) {
          if (phase === 'after-save') {
            write(path, value)
          }
          throw new Error('drain receipt fsync failed')
        }
      }
      return write(path, value)
    })
    await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow(
      'drain receipt fsync failed'
    )
    expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
    expect(f.hostStore.loadAll()).toEqual([])
    const receipts = new OrcadOutgoingPreparationDrainReceiptStore(root)
    const uncertain = receipts.read(identity)
    expect(uncertain !== null).toBe(phase === 'after-save')
    expect(f.store.read(identity)).not.toBeNull()
    failDrain = false
    await prepareOutgoingOrcadSource({
      ...f.options,
      store: new OrcadOutgoingPreparationStore(root)
    })
    expect(drainWrites).toBe(2)
    expect(f.provider.drainOutgoingSourceControls).toHaveBeenCalledTimes(2)
    expect(f.provider.requestHostRpc).toHaveBeenCalledOnce()
    const saved = receipts.read(identity)!
    if (uncertain) {
      expect(saved).toEqual(uncertain)
    }
    expect(JSON.stringify(saved)).not.toContain(f.options.preparation.source!.proof.credential)
    expect(JSON.stringify(saved)).not.toContain(f.options.preparation.source!.endpointCredential)
  }
)

it('does not contact source when durable permissions are unconfirmed', async () => {
  const f = fixture()
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockReturnValueOnce(false)
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('permissions_unconfirmed')
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
  expect(f.hostStore.loadAll()).toEqual([])
})

it.each([
  'destinationDelegationVersion',
  'preparationShutdownGuardVersion',
  'transferGraceGuardVersion',
  'transferLifecycleGuardVersion',
  'captureBoundaryVersion',
  'captureSelectionVersion'
] as const)('refuses unsupported %s before preparation', async (key) => {
  const f = fixture()
  const capabilities = await f.provider.getOwnershipBridgeCapabilities()
  f.provider.getOwnershipBridgeCapabilities.mockResolvedValue({ ...capabilities, [key]: 2 })
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('unsupported')
  expect(f.store.read(identity)).toBeNull()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('refuses mismatched source evidence without deleting the prepared intent', async () => {
  const f = fixture()
  const request = f.provider.requestHostRpc.getMockImplementation()!
  f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => ({
    ...(await request(method, params)),
    ownerLease: 'other'
  }))
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('reply_unverifiable')
  expect(f.store.read(identity)).not.toBeNull()
  expect(f.hostStore.loadAll()).toHaveLength(1)
})

it.each([
  'preparationShutdownGuardVersion',
  'transferGraceGuardVersion',
  'transferLifecycleGuardVersion'
])('refuses a host omitting %s before drain or durable preparation', async (key) => {
  const f = fixture()
  const capabilities = await f.provider.getOwnershipBridgeCapabilities()
  Reflect.deleteProperty(capabilities, key)
  f.provider.getOwnershipBridgeCapabilities.mockResolvedValue(capabilities)
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('unsupported')
  expect(f.store.read(identity)).toBeNull()
  expect(f.provider.drainOutgoingSourceControls).not.toHaveBeenCalled()
  expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
})

it('preserves prepared source and intent when the provider changes before its reply arrives', async () => {
  const f = fixture()
  const request = f.provider.requestHostRpc.getMockImplementation()!
  f.provider.requestHostRpc.mockImplementationOnce(async (method, params) => {
    const reply = await request(method, params)
    registry.provider.mockReturnValue({})
    return reply
  })
  await expect(prepareOutgoingOrcadSource(f.options)).rejects.toThrow('source_authority_changed')
  expect(f.store.read(identity)).not.toBeNull()
  expect(f.hostStore.loadAll()).toHaveLength(1)
  expect(f.provider.requestHostRpc).toHaveBeenCalledOnce()
})
