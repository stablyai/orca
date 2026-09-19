import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coveredCancellationFixture } from './orcad-live-covered-cancellation-test-fixture'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import {
  createOrcadLiveCoveredCancellationReceipt,
  OrcadLiveCoveredCancellationReceiptStore
} from './orcad-live-covered-cancellation-receipt'
import { retireOrcadLiveSuccessorSourceDeliveries } from './orcad-live-successor-source-retirement'
import type { withOutgoingOrcadSuccessorAuthority } from './orcad-outgoing-authority'
import {
  createOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'

const mocked = vi.hoisted(() => ({
  sessions: new Map(),
  retire: vi.fn(),
  assertNative: vi.fn(),
  owner: vi.fn(),
  manager: vi.fn(),
  resume: vi.fn()
}))
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: mocked.manager,
  getSshTargetRegistryStore: vi.fn()
}))
vi.mock('./orcad-saved-source-resume', () => ({ resumeOrcadSavedSshSource: mocked.resume }))
vi.mock('../ipc/ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: vi.fn(),
  connectInFlight: new Set(),
  pendingTransportReconnects: new Set(),
  resetRelayInFlight: new Set(),
  testingTargets: new Set(),
  hasSshTestConnectionProbes: vi.fn()
}))
vi.mock('../ipc/ssh-reset-production-state', () => ({ assertSshResetAdmissionAllowed: vi.fn() }))
vi.mock('../ipc/ssh-active-relay-sessions', () => ({ activeSessions: mocked.sessions }))
vi.mock('./orcad-successor-retirement-client', () => ({
  retireOrcadSuccessorSourceDelivery: mocked.retire
}))
vi.mock('./orcad-outgoing-authority', () => ({
  withOutgoingOrcadSuccessorAuthority: async (
    ...[_path, args, run]: Parameters<typeof withOutgoingOrcadSuccessorAuthority>
  ) =>
    run({
      pairingCode: 'modeled-pairing',
      assertSourceCutoverOwner: mocked.owner,
      assertAuthority: () => {
        mocked.assertNative()
        args.assertEvidence()
      }
    })
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-successor-cohort-'))
  vi.resetAllMocks()
  mocked.sessions.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const first = coveredCancellationFixture()
  const cutover = first.record.release.cutover
  const second = structuredClone(first)
  const binding = cutover.liveTerminalBindings![1]
  second.capture.identity = binding.identity
  second.capture.surfaceBinding = binding.surfaceBinding
  second.capture.source.proof = { ...binding.identity, version: 1, credential: 'a'.repeat(64) }
  second.capture.model.identity = binding.identity
  second.capture.selection.boundary.identity = binding.identity
  Object.assign(second.capture.selection.boundary.delivery, {
    id: binding.identity.terminalId,
    ptyIncarnation: binding.identity.incarnationId,
    ownerGeneration: binding.identity.sourceOwnerGeneration
  })
  second.capture.selection.modelSha256 = digestPtyOwnershipInitialModelSnapshot(
    second.capture.model,
    binding.identity,
    1
  )
  second.request = {
    ...second.request,
    ...binding.identity,
    savedBaseline: structuredClone(second.capture.selection)
  }
  second.retirement = {
    ...second.retirement,
    ...binding.identity,
    coveredSourceDeliveryRetirement: {
      ...second.retirement.coveredSourceDeliveryRetirement,
      modelSha256: second.capture.selection.modelSha256,
      receipt: cutover.terminalPublications![1].publicationReceipt.commitReceipt,
      delivery: {
        ...second.capture.selection.boundary.delivery,
        receivedEndSu: 400,
        sentEndSu: 356
      }
    }
  }
  new OrcadLiveCutoverIntentStore(root).persist({
    ...cutover,
    phase: 'source-fenced',
    terminalPublications: undefined
  })
  new OrcadLiveSourceRetirementRecordStore(root).persist(first.record)
  const captures = new OrcadOutgoingCaptureStore(root)
  captures.persist(first.capture)
  captures.persist(second.capture)
  const targetId = cutover.manifest.source.sshTargetId
  const admitted = {
    targetId,
    resumed: true,
    owner: {
      mode: 'negotiated',
      ownerLease: first.request.ownerLease,
      ownerGeneration: first.request.successorGeneration,
      clientInstanceId: 'client',
      clientGeneration: 2
    },
    mux: { isDisposed: () => false },
    connection: {},
    transportGeneration: 1
  }
  const session = { readSuccessorRetirementSession: vi.fn(() => admitted) }
  mocked.sessions.set(targetId, session)
  const store = {
    getSshPtyConsumerRecovery: vi.fn(() => null),
    upsertSshPtyConsumerRecovery: vi.fn(async () => {}),
    getSshTarget: () => ({
      id: targetId,
      label: cutover.manifest.source.targetLabel,
      generation: cutover.manifest.source.sshTargetGeneration!,
      host: 'host',
      port: 22,
      username: 'user',
      owner: createManagedOrcadSshOwner(cutover.destinationEnvironmentId)
    }),
    listOrcadMigrationSourceCutovers: () => [cutover]
  }
  mocked.retire.mockImplementation(async ({ request }) =>
    request.bridgeId === first.request.bridgeId ? first.retirement : second.retirement
  )
  const run = () =>
    retireOrcadLiveSuccessorSourceDeliveries({
      profileDirectory: root,
      store,
      migrationId: cutover.manifest.migrationId,
      signal: new AbortController().signal,
      recoveryOnly: false
    })
  return { first, second, run, store, session, admitted, captures, targetId }
}

it('persists exact host results for both terminals without claiming profile completion', async () => {
  const f = setup()
  const result = await f.run()
  expect(mocked.retire).toHaveBeenCalledTimes(2)
  expect(mocked.owner).toHaveBeenCalledWith('fenced')
  expect(result.phase).toBe('source-deliveries-retired')
  expect(result).not.toHaveProperty('sourceRetirement')
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toEqual(
    expect.arrayContaining(result.receipts)
  )
})

it('requires the committed journal before host calls', async () => {
  const f = setup()
  vi.spyOn(f.store, 'listOrcadMigrationSourceCutovers').mockReturnValue([])
  await expect(f.run()).rejects.toThrow('commit_required')
  expect(mocked.retire).not.toHaveBeenCalled()
})

it('requires the exact retirement record before host calls', async () => {
  const f = setup()
  vi.spyOn(OrcadLiveSourceRetirementRecordStore.prototype, 'read').mockReturnValue(null)
  await expect(f.run()).rejects.toThrow('retirement_record_required')
  expect(mocked.retire).not.toHaveBeenCalled()
})

it('preflights every capture before retiring the first terminal', async () => {
  const f = setup()
  const original = OrcadOutgoingCaptureStore.prototype.read
  vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockImplementation(
    function (this: OrcadOutgoingCaptureStore, identity) {
      return identity.bridgeId === f.second.request.bridgeId ? null : original.call(this, identity)
    }
  )
  await expect(f.run()).rejects.toThrow('capture_binding_mismatch')
  expect(mocked.retire).not.toHaveBeenCalled()
})

it('refuses a fresh admission before host calls', async () => {
  const f = setup()
  f.admitted.resumed = false
  await expect(f.run()).rejects.toThrow('session_required')
  expect(mocked.retire).not.toHaveBeenCalled()
})

it('revalidates an existing receipt capture while retiring another cohort member', async () => {
  const f = setup()
  const receipts = new OrcadLiveCoveredCancellationReceiptStore(root)
  const saved = receipts.persist(createOrcadLiveCoveredCancellationReceipt(f.first))
  mocked.retire.mockImplementation(async () => {
    const original = OrcadOutgoingCaptureStore.prototype.read
    vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockImplementation(
      function (this: OrcadOutgoingCaptureStore, identity) {
        return identity.bridgeId === f.first.request.bridgeId ? null : original.call(this, identity)
      }
    )
    return f.second.retirement
  })
  await expect(f.run()).rejects.toThrow('capture_missing')
  expect(mocked.retire).toHaveBeenCalledTimes(1)
  expect(receipts.list()).toEqual([saved])
})

it('retains a confirmed first member across a later failure and retries only the remainder', async () => {
  const f = setup()
  mocked.retire
    .mockResolvedValueOnce(f.first.retirement)
    .mockRejectedValueOnce(new Error('offline'))
  await expect(f.run()).rejects.toThrow('offline')
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toHaveLength(1)
  mocked.retire.mockClear()
  mocked.retire.mockResolvedValue(f.second.retirement)
  expect((await f.run()).receipts).toHaveLength(2)
  expect(mocked.retire).toHaveBeenCalledTimes(1)
  expect(mocked.retire.mock.calls[0][0].request.bridgeId).toBe(f.second.request.bridgeId)
})

it('reflushes existing covered receipts with no session or host call', async () => {
  const f = setup()
  const receipts = new OrcadLiveCoveredCancellationReceiptStore(root)
  receipts.persist(createOrcadLiveCoveredCancellationReceipt(f.first))
  receipts.persist(createOrcadLiveCoveredCancellationReceipt(f.second))
  mocked.sessions.clear()
  expect((await f.run()).receipts).toHaveLength(2)
  expect(mocked.retire).not.toHaveBeenCalled()
  expect(mocked.manager).not.toHaveBeenCalled()
  expect(mocked.resume).not.toHaveBeenCalled()
})

function setupOwned() {
  const f = setup()
  mocked.sessions.clear()
  const connection = {
    getState: () => ({ status: 'connected' }),
    getTarget: () => f.store.getSshTarget(),
    disconnect: vi.fn(),
    dispose: vi.fn()
  }
  const manager = {
    getConnection: vi.fn((): typeof connection | undefined => connection),
    connect: vi.fn(),
    connectExclusive: vi.fn()
  }
  mocked.manager.mockReturnValue(manager)
  const owned = {
    session: { ...f.admitted, connection },
    assertCurrent: vi.fn(),
    dispose: vi.fn()
  }
  mocked.resume.mockResolvedValue(owned)
  return { ...f, connection, manager, owned }
}

it('waits for fresh exclusive raw cleanup after persisting the whole retirement cohort', async () => {
  const f = setupOwned()
  f.manager.getConnection.mockReturnValue(undefined)
  const cleanup = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const release = vi.fn(() => {
    closing.resolve()
    return cleanup.promise
  })
  f.manager.connectExclusive.mockImplementation(async () => {
    f.manager.getConnection.mockReturnValue(f.connection)
    return { connection: f.connection, release }
  })
  const finished = vi.fn()
  const running = f.run().then(finished)
  await closing.promise
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toHaveLength(2)
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  cleanup.resolve()
  await running
  expect(finished).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
  expect(f.manager.connect).not.toHaveBeenCalled()
})

it('preserves retirement failure alongside exclusive raw cleanup failure', async () => {
  const f = setupOwned()
  f.manager.getConnection.mockReturnValue(undefined)
  const retirementError = new Error('retirement-failed')
  const cleanupError = new Error('cleanup-failed')
  const release = vi.fn().mockRejectedValue(cleanupError)
  f.manager.connectExclusive.mockImplementation(async () => {
    f.manager.getConnection.mockReturnValue(f.connection)
    return { connection: f.connection, release }
  })
  mocked.retire.mockRejectedValue(retirementError)
  await expect(f.run()).rejects.toMatchObject({
    message: 'orcad_live_successor_retirement_cleanup_failed',
    errors: [retirementError, cleanupError]
  })
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it('uses the existing connected source without an active relay and releases its owned session', async () => {
  const f = setupOwned()
  const result = await f.run()
  expect(result.receipts).toHaveLength(2)
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toHaveLength(2)
  expect(mocked.resume).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: f.connection,
      targetId: f.targetId,
      source: {
        endpoint: f.first.capture.source.endpoint,
        incumbentVersion: f.first.capture.source.incumbentVersion,
        endpointCredential: f.first.capture.source.endpointCredential
      },
      ownerLease: f.first.capture.identity.ownerLease
    })
  )
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(f.manager.connect).not.toHaveBeenCalled()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
  expect(f.connection.dispose).not.toHaveBeenCalled()
})

it('does not resume a saved source before the entire missing capture cohort is bound', async () => {
  const f = setupOwned()
  const read = OrcadOutgoingCaptureStore.prototype.read
  vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockImplementation(
    function (this: OrcadOutgoingCaptureStore, identity) {
      return identity.bridgeId === f.second.request.bridgeId ? null : read.call(this, identity)
    }
  )
  await expect(f.run()).rejects.toThrow('capture_binding_mismatch')
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(mocked.manager).not.toHaveBeenCalled()
  expect(mocked.retire).not.toHaveBeenCalled()
})

it('retains the first receipt and closes its owned session after partial retirement failure', async () => {
  const f = setupOwned()
  mocked.retire
    .mockResolvedValueOnce(f.first.retirement)
    .mockRejectedValueOnce(new Error('offline'))
  await expect(f.run()).rejects.toThrow('offline')
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toEqual([
    createOrcadLiveCoveredCancellationReceipt(f.first)
  ])
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('closes resumed owned transport when capture authority changes during resume', async () => {
  const f = setupOwned()
  mocked.resume.mockImplementation(async () => {
    vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockReturnValue(null)
    return f.owned
  })
  await expect(f.run()).rejects.toThrow('capture_changed')
  expect(f.owned.dispose).toHaveBeenCalledOnce()
  expect(mocked.retire).not.toHaveBeenCalled()
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toEqual([])
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('reuses mixed ordinary and covered receipts without host calls', async () => {
  const f = setup()
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(
    createOrcadLiveCoveredCancellationReceipt(f.first)
  )
  const record = f.first.record
  const settlements = record.release.cutover.liveTerminalBindings!.map(({ identity }) => ({
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 91,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'token',
    fromSourceEndSu: 100,
    throughSourceEndSu: 100
  }))
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  new OrcadLiveCleanupOutputEvidenceStore(root).persist(
    createOrcadLiveCleanupOutputEvidence(record, settlements)
  )
  new OrcadLiveSourceCancellationReceiptStore(root).persist(
    createOrcadLiveSourceCancellationReceipt({
      record,
      settlements,
      retirement: {
        version: 1,
        ...f.second.capture.identity,
        sourceDeliveryRetirement: {
          phase: 'retired',
          retirementRecordSha256: record.sha256,
          delivery: f.second.capture.selection.boundary.delivery
        }
      },
      cancellation: { canceled: true, sentEndSu: 100, creditedEndSu: 100 }
    })
  )
  mocked.sessions.clear()
  expect((await f.run()).receipts.map((receipt) => receipt.version).sort()).toEqual([1, 2])
  expect(mocked.retire).not.toHaveBeenCalled()
})

it.each(['authority', 'session', 'capture'] as const)(
  'refuses %s invalidation while awaiting host result',
  async (kind) => {
    const f = setup()
    mocked.retire.mockImplementation(async () => {
      if (kind === 'authority') {
        mocked.assertNative.mockImplementation(() => {
          throw new Error('native-lost')
        })
      }
      if (kind === 'session') {
        mocked.sessions.delete(f.targetId)
      }
      if (kind === 'capture') {
        vi.spyOn(OrcadOutgoingCaptureStore.prototype, 'read').mockReturnValue(null)
      }
      return f.first.retirement
    })
    await expect(f.run()).rejects.toThrow()
    expect(mocked.retire).toHaveBeenCalledTimes(1)
    expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toEqual([])
  }
)
