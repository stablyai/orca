import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coveredCancellationFixture } from './orcad-live-covered-cancellation-test-fixture'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { OrcadSourceRetirementPersistence } from '../persistence/migrating-orcad-catalog/orcad-source-retirement-persistence'
import { OrcadRetirementSessionPublication } from '../persistence/loading-store/orcad-retirement-session-publication'
import { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import {
  createOrcadLiveCoveredCancellationReceipt,
  OrcadLiveCoveredCancellationReceiptStore
} from './orcad-live-covered-cancellation-receipt'
import { installOrcadLiveSuccessorSourceProfile } from './orcad-live-successor-profile-installation'
import { parseOrcadCatalogActivationRequest } from './orcad-catalog-activation-contract'
import * as secureFile from '../../shared/secure-file'
import { OrcadLiveAppliedCoverageEvidenceStore } from './orcad-live-applied-coverage-evidence'
import type { withOrcadCommittedSuccessorProfileAuthority } from './orcad-committed-profile-authority'

const mocked = vi.hoisted(() => ({ authority: vi.fn(), resume: vi.fn() }))
vi.mock('./orcad-committed-profile-authority', () => ({
  withOrcadCommittedSuccessorProfileAuthority: (...args: unknown[]) => mocked.authority(...args)
}))
vi.mock('./orcad-live-successor-session', () => ({
  retainOrcadLiveSuccessorSession: mocked.resume
}))

let directory: string
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'orca-successor-profile-coordinator-'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(receiptCount = 2) {
  const f = liveSourceRetirementFixture()
  const first = coveredCancellationFixture()
  const { record } = first
  new OrcadLiveSourceRetirementRecordStore(directory).persist(record)
  const captures = new OrcadOutgoingCaptureStore(directory)
  const receipts = new OrcadLiveCoveredCancellationReceiptStore(directory)
  record.release.cutover.liveTerminalBindings!.forEach((binding, index) => {
    const entry = structuredClone(first)
    entry.capture.identity = binding.identity
    entry.capture.surfaceBinding = binding.surfaceBinding
    entry.capture.source.proof = { ...binding.identity, version: 1, credential: 'a'.repeat(64) }
    entry.capture.model.identity = binding.identity
    entry.capture.selection.boundary.identity = binding.identity
    Object.assign(entry.capture.selection.boundary.delivery, {
      id: binding.identity.terminalId,
      ptyIncarnation: binding.identity.incarnationId,
      ownerGeneration: binding.identity.sourceOwnerGeneration
    })
    entry.capture.selection.modelSha256 = digestPtyOwnershipInitialModelSnapshot(
      entry.capture.model,
      binding.identity,
      1
    )
    entry.request = {
      ...entry.request,
      ...binding.identity,
      savedBaseline: structuredClone(entry.capture.selection)
    }
    entry.retirement = {
      ...entry.retirement,
      ...binding.identity,
      coveredSourceDeliveryRetirement: {
        ...entry.retirement.coveredSourceDeliveryRetirement,
        modelSha256: entry.capture.selection.modelSha256,
        receipt:
          record.release.cutover.terminalPublications![index].publicationReceipt.commitReceipt,
        delivery: {
          ...entry.capture.selection.boundary.delivery,
          receivedEndSu: 400,
          sentEndSu: 356
        }
      }
    }
    captures.persist(entry.capture)
    if (index < receiptCount) {
      receipts.persist(createOrcadLiveCoveredCancellationReceipt(entry))
    }
  })
  const publication = new OrcadRetirementSessionPublication(directory)
  type Scheduling = ConstructorParameters<typeof WriteSchedulingOperations>
  const scheduling = new WriteSchedulingOperations(
    {
      automationListProjectionCache: null,
      quitFlushStarted: false,
      writeGeneration: 0,
      firstPendingSaveAt: null,
      writeTimer: null
    } as unknown as Scheduling[0],
    {} as Scheduling[1]
  )
  const domain = new OrcadSourceRetirementPersistence(
    {
      state: f.state,
      terminalScrollbackSnapshotStorage: {},
      orcadRetirementSessionPublication: publication
    },
    scheduling
  )
  const owner = { ...f.state.sshPtyConsumerRecoveries![0], clientGeneration: 2, ownerGeneration: 2 }
  f.state.sshPtyConsumerRecoveries = [owner]
  // Native/session/runtime guards and profile flush are modeled; records and typed installation are real.
  const assertAuthority = vi.fn()
  mocked.authority.mockImplementation(
    async (...[, operation]: Parameters<typeof withOrcadCommittedSuccessorProfileAuthority>) =>
      operation({
        intent: f.cutover,
        cutover: f.cutover,
        assertAuthority,
        pairingCode: 'modeled',
        transitionCompletedJournal: vi.fn()
      })
  )
  const assertCurrent = vi.fn(() => {
    if (!f.state.sshPtyConsumerRecoveries?.length) {
      throw new Error('source_recovery_removed')
    }
  })
  const retained = {
    assertCurrent,
    readSession: () => {
      assertCurrent()
      const { targetId, serverBuildId: _build, ...claim } = owner
      return {
        targetId,
        resumed: true,
        owner: { mode: 'negotiated', ...claim },
        mux,
        connection,
        transportGeneration: 1
      }
    },
    dispose: vi.fn(async () => {})
  }
  const mux = { isDisposed: () => false }
  const connection = {}
  mocked.resume.mockResolvedValue(retained)
  const store = {
    getSshTarget: vi.fn(() => f.state.sshTargets![0]),
    listOrcadMigrationSourceCutovers: vi.fn(() => f.state.orcadMigrationSourceCutovers!),
    getSshPtyConsumerRecovery: vi.fn(() => f.state.sshPtyConsumerRecoveries?.[0] ?? null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn(() => f.state.sshRemotePtyLeases!),
    inspectOrcadLiveRetirementProfileState:
      domain.inspectOrcadLiveRetirementProfileState.bind(domain),
    installOrcadLiveSuccessorRetirementProfile: vi.fn(
      domain.installOrcadLiveSuccessorRetirementProfile.bind(domain)
    ),
    flushPendingOrThrowAsync: vi.fn(async () => {})
  }
  const absence = { assertAbsent: vi.fn() }
  const runtime = { bindOutgoingSshPtySurfaceAbsence: vi.fn(() => absence) }
  const committed = {
    state: 'committed' as const,
    migrationId: f.cutover.manifest.migrationId,
    manifestSha256: f.cutover.manifest.manifestSha256,
    receipt: record.release.cutover.receipt
  }
  const remote = {
    read: vi.fn(async () => committed),
    commit: vi.fn(async () => committed)
  }
  const activate = vi.fn<
    NonNullable<Parameters<typeof installOrcadLiveSuccessorSourceProfile>[0]['activate']>
  >(async ({ request }) =>
    structuredClone(
      record.release.activations.find(
        (entry) =>
          entry.identity.bridgeId === parseOrcadCatalogActivationRequest(request).identity.bridgeId
      )!
    )
  )
  const inspectCoverage = vi.fn<
    NonNullable<Parameters<typeof installOrcadLiveSuccessorSourceProfile>[0]['inspectCoverage']>
  >(async ({ request }) => ({
    ...structuredClone(
      record.release.activations.find(
        (entry) =>
          entry.identity.bridgeId === parseOrcadCatalogActivationRequest(request).identity.bridgeId
      )!
    ),
    coverage: {
      throughSeq: Number(request.throughSeq),
      acknowledgedEndSeq: Number(request.throughSeq),
      modelThroughSeq: Number(request.throughSeq),
      modelSequenceEnd: 400
    }
  }))
  const run = () =>
    installOrcadLiveSuccessorSourceProfile({
      profileDirectory: directory,
      store,
      runtime,
      remote,
      activate,
      inspectCoverage,
      migrationId: f.cutover.manifest.migrationId,
      signal: new AbortController().signal,
      now: () => new Date(f.cutover.updatedAt)
    })
  return {
    ...f,
    record,
    store,
    runtime,
    absence,
    retained,
    assertAuthority,
    remote,
    activate,
    inspectCoverage,
    run
  }
}

it('installs real typed profile with a newer owner and disposes after recovery removal', async () => {
  const f = fixture()
  f.retained.dispose.mockImplementation(async () => {
    expect(f.state.sshPtyConsumerRecoveries).toEqual([])
  })
  const result = await f.run()
  expect(result.marker.recordSha256).toBe(f.record.sha256)
  expect(f.state.sshRemotePtyLeases).toEqual([])
  expect(f.retained.dispose).toHaveBeenCalledOnce()
  expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
})

it('does not return success until profile persistence flush completes', async () => {
  const f = fixture()
  const flush = Promise.withResolvers<void>()
  f.store.flushPendingOrThrowAsync.mockReturnValue(flush.promise)
  let complete = false
  const pending = f.run().then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledOnce())
  expect(complete).toBe(false)
  flush.resolve()
  await pending
  expect(complete).toBe(true)
})

it('rejects an incomplete cancellation cohort before resume or installation', async () => {
  const f = fixture(1)
  await expect(f.run()).rejects.toThrow()
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
})

it('refuses present runtime surfaces before resume or installation', async () => {
  const f = fixture()
  f.absence.assertAbsent.mockImplementation(() => {
    throw new Error('surfaces_present')
  })
  await expect(f.run()).rejects.toThrow('surfaces_present')
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
})

it('retries an installed profile under absence without reopening a source session', async () => {
  const f = fixture()
  await f.run()
  mocked.resume.mockClear()
  f.store.installOrcadLiveSuccessorRetirementProfile.mockClear()
  await f.run()
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
  expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
})

it('preserves installation and owned-session cleanup failures together', async () => {
  const f = fixture()
  const failure = new Error('install_failed')
  const cleanup = new Error('cleanup_failed')
  f.store.installOrcadLiveSuccessorRetirementProfile.mockImplementation(() => {
    throw failure
  })
  f.retained.dispose.mockRejectedValue(cleanup)
  await expect(f.run()).rejects.toMatchObject({
    message: 'orcad_live_successor_profile_cleanup_failed',
    errors: [failure, cleanup]
  })
  expect(f.store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
})

it('retries a rejected flush from the installed state without resuming the source', async () => {
  const f = fixture()
  f.store.flushPendingOrThrowAsync.mockRejectedValueOnce(new Error('flush_failed'))
  await expect(f.run()).rejects.toThrow('flush_failed')
  expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
  mocked.resume.mockClear()
  await f.run()
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
})

it.each(['absence', 'native'] as const)(
  'refuses success when %s authority changes during flush',
  async (kind) => {
    const f = fixture()
    f.store.flushPendingOrThrowAsync.mockImplementation(async () => {
      const assertion = kind === 'absence' ? f.absence.assertAbsent : f.assertAuthority
      assertion.mockImplementation(() => {
        throw new Error('authority_changed')
      })
    })
    await expect(f.run()).rejects.toThrow('authority_changed')
    expect(f.retained.dispose).toHaveBeenCalledOnce()
  }
)

it('reports post-install disposal failure and retries without reopening the source', async () => {
  const f = fixture()
  f.retained.dispose.mockRejectedValueOnce(new Error('dispose_failed'))
  await expect(f.run()).rejects.toThrow('dispose_failed')
  expect(f.store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
  expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
  mocked.resume.mockClear()
  await f.run()
  expect(mocked.resume).not.toHaveBeenCalled()
})

it('reconfirms the pinned destination and every activation before reopening the source', async () => {
  const f = fixture()
  const resumed = mocked.resume.getMockImplementation()!
  mocked.resume.mockImplementation(async (...args: unknown[]) => {
    expect(f.remote.read).toHaveBeenCalledOnce()
    expect(f.remote.commit).toHaveBeenCalledOnce()
    expect(f.activate).toHaveBeenCalledTimes(2)
    expect(f.inspectCoverage).toHaveBeenCalledTimes(2)
    expect(f.remote.read).toHaveBeenCalledWith('modeled', f.cutover.manifest, {
      signal: expect.any(AbortSignal),
      expectedRuntimeId: f.record.identity.destinationRuntimeId
    })
    return resumed(...args)
  })
  await f.run()
})

it.each(['unavailable', 'receipt-changed', 'activation-unavailable', 'claim-replaced'])(
  'preserves the source profile when destination is %s',
  async (kind) => {
    const f = fixture()
    const before = structuredClone(f.state)
    if (kind === 'unavailable') {
      f.remote.read.mockRejectedValueOnce(new Error('destination unavailable'))
    } else if (kind === 'receipt-changed') {
      const response = await f.remote.read()
      f.remote.read.mockResolvedValue({
        ...response,
        receipt: { ...response.receipt, importedAt: '2030-01-01T00:00:00.000Z' }
      })
    } else if (kind === 'activation-unavailable') {
      f.activate.mockRejectedValueOnce(new Error('activation unavailable'))
    } else {
      const activate = f.activate.getMockImplementation()!
      f.activate.mockImplementation(async (args) => ({
        ...(await activate(args)),
        destinationClaim: { generation: 1, claimId: 'replacement' }
      }))
    }
    await expect(f.run()).rejects.toThrow()
    expect(f.state).toEqual(before)
    expect(mocked.resume).not.toHaveBeenCalled()
    expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
  }
)

it('rechecks current runtime absence after awaiting destination activation', async () => {
  const f = fixture()
  const activate = f.activate.getMockImplementation()!
  f.activate.mockImplementationOnce(async (args) => {
    const result = await activate(args)
    f.absence.assertAbsent.mockImplementation(() => {
      throw new Error('surface returned')
    })
    return result
  })
  await expect(f.run()).rejects.toThrow('surface returned')
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
})

it.each(['queued-only', 'unsupported', 'changed-claim'])(
  'preserves source profile with %s destination coverage',
  async (kind) => {
    const f = fixture()
    const before = structuredClone(f.state)
    const inspect = f.inspectCoverage.getMockImplementation()!
    f.inspectCoverage.mockImplementation(async (args) => {
      if (kind === 'unsupported') {
        throw new Error('coverage unsupported')
      }
      const result = await inspect(args)
      if (kind === 'queued-only') {
        result.coverage.modelThroughSeq = 0
      } else {
        Object.assign(result.destinationClaim, { claimId: 'replaced' })
      }
      return result
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.state).toEqual(before)
    expect(mocked.resume).not.toHaveBeenCalled()
    expect(f.store.installOrcadLiveSuccessorRetirementProfile).not.toHaveBeenCalled()
  }
)

it('requires durable applied evidence before source resume or profile installation', async () => {
  const f = fixture()
  const before = structuredClone(f.state)
  vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockReturnValue(false)
  await expect(f.run()).rejects.toThrow('permissions_unconfirmed')
  expect(mocked.resume).not.toHaveBeenCalled()
  expect(f.state).toEqual(before)
})

it('keeps first applied evidence on a stronger fresh retry', async () => {
  const f = fixture()
  await f.run()
  const evidence = new OrcadLiveAppliedCoverageEvidenceStore(directory)
  const first = evidence.read(f.record.identity)
  const inspect = f.inspectCoverage.getMockImplementation()!
  f.inspectCoverage.mockImplementation(async (args) => {
    const result = await inspect(args)
    result.coverage.modelSequenceEnd++
    return result
  })
  await f.run()
  expect(evidence.read(f.record.identity)).toEqual(first)
})

it('refuses fresh coverage that regresses behind retained history', async () => {
  const f = fixture()
  const inspect = f.inspectCoverage.getMockImplementation()!
  f.inspectCoverage.mockImplementation(async (args) => {
    const result = await inspect(args)
    Object.assign(result.destinationClaim, { generation: 3, claimId: 'newer' })
    return result
  })
  await f.run()
  f.inspectCoverage.mockImplementation(inspect)
  await expect(f.run()).rejects.toThrow('coverage_regressed')
})

it('rechecks retained applied evidence after profile flush', async () => {
  const f = fixture()
  f.store.flushPendingOrThrowAsync.mockImplementation(async () => {
    rmSync(join(directory, 'orcad-live-applied-coverage-evidence'), { recursive: true })
  })
  await expect(f.run()).rejects.toThrow('evidence_required')
})
