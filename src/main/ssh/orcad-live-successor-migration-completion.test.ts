import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type * as CompletionModule from './orcad-live-successor-migration-completion'
import type * as RecordsModule from './orcad-live-successor-completion-records'
import type * as OwnershipModule from '../ipc/pty/provider/ownership-state'
import type * as RefusalModule from '../ipc/pty/provider/outgoing-source-route-refusal'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { withOrcadLiveSuccessorReadiness } from './orcad-live-successor-readiness'

const mocked = vi.hoisted(() => ({ readiness: vi.fn() }))
vi.mock('./orcad-live-successor-readiness', () => ({
  withOrcadLiveSuccessorReadiness: (...args: unknown[]) => mocked.readiness(...args)
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  sshProviders: new Map(),
  sshProvidersByGeneration: new Map()
}))
let root: string
let completion: typeof CompletionModule
let records: typeof RecordsModule
let ownership: typeof OwnershipModule
let refusal: typeof RefusalModule
beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'orca-successor-migration-complete-'))
  completion = await import('./orcad-live-successor-migration-completion')
  records = await import('./orcad-live-successor-completion-records')
  ownership = await import('../ipc/pty/provider/ownership-state')
  refusal = await import('../ipc/pty/provider/outgoing-source-route-refusal')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = appliedCoverageFixture(root)
  const appliedEvidence = f.create()
  f.evidenceStore.persist(appliedEvidence)
  const preparation = records.createOrcadLiveSuccessorCompletionPreparation(root, f.record)
  new records.OrcadLiveSuccessorCompletionPreparationStore(root).persist(preparation)
  new records.OrcadLiveSuccessorRouteCheckpointStore(root).persist(
    records.createOrcadLiveSuccessorRouteCheckpoint(preparation)
  )
  const receipts = bindOrcadLiveCancellationCohort(root, f.record).receipts
  const controller = new AbortController()
  let journal: OrcadMigrationSourceCutover = structuredClone(f.record.release.cutover)
  const assertCurrent = vi.fn(() => controller.signal.throwIfAborted())
  type Callback = Parameters<Parameters<typeof withOrcadLiveSuccessorReadiness>[1]>[0]
  mocked.readiness.mockImplementation(
    async (
      options: { allowCompleted?: boolean },
      operation: (context: Callback) => Promise<unknown>
    ) => {
      expect(options.allowCompleted).toBe(true)
      assertCurrent()
      const result = await operation({
        record: f.record,
        appliedEvidence,
        receipts,
        assertCurrent,
        transitionCompletedJournal: (_candidate: unknown, write: () => void) => {
          assertCurrent()
          write()
          assertCurrent()
        }
      })
      assertCurrent()
      return result
    }
  )
  const store = {
    getSshTarget: vi.fn(),
    listOrcadMigrationSourceCutovers: () => [journal],
    inspectOrcadLiveRetirementProfileState: vi.fn(() => ({ state: 'profile-installed' })),
    completeOrcadLiveRetirementProfile: vi.fn(
      (
        _record: unknown,
        candidate: OrcadMigrationSourceCutover,
        admission: { assertCurrent: () => void }
      ) => {
        admission.assertCurrent()
        journal = candidate
      }
    ),
    flushPendingOrThrowAsync: vi.fn(async () => {}),
    isOrcadLiveCompletionDurable: vi.fn(() => true)
  }
  const now = vi.fn(() => new Date('2026-09-07T12:00:00.000Z'))
  const run = () =>
    completion.completeOrcadLiveSuccessorMigration({
      profileDirectory: root,
      store: store as never,
      runtime: {} as never,
      migrationId: f.record.release.cutover.manifest.migrationId,
      signal: controller.signal,
      now
    })
  const targetId = f.record.release.cutover.manifest.source.sshTargetId
  const ids = f.record.release.cutover.liveTerminalBindings!.map(({ identity }) =>
    toAppSshPtyId(targetId, identity.terminalId)
  )
  expect(
    refusal.hasExactOutgoingSourcePtyRouteRefusal(ids[0], f.record.identity, f.record.sha256)
  ).toBe(false)
  return {
    ...f,
    receipts,
    controller,
    assertCurrent,
    store,
    run,
    now,
    targetId,
    ids,
    journal: () => journal
  }
}

it('writes version-2 completion only after preserving mixed evidence and exact route refusal', async () => {
  const f = fixture()
  const { OrcadLiveSourceCancellationReceiptStore } =
    await import('./orcad-live-source-cancellation-receipt')
  const { OrcadLiveCoveredCancellationReceiptStore } =
    await import('./orcad-live-covered-cancellation-receipt')
  const { OrcadLiveAppliedCoverageEvidenceStore } =
    await import('./orcad-live-applied-coverage-evidence')
  const ordinary = vi.spyOn(OrcadLiveSourceCancellationReceiptStore.prototype, 'persist')
  const covered = vi.spyOn(OrcadLiveCoveredCancellationReceiptStore.prototype, 'persist')
  const applied = vi.spyOn(OrcadLiveAppliedCoverageEvidenceStore.prototype, 'persist')
  const result = await f.run()
  expect(ordinary).toHaveBeenCalledOnce()
  expect(covered).toHaveBeenCalledOnce()
  expect(applied).toHaveBeenCalledOnce()
  expect(result).toMatchObject({
    phase: 'source-retired',
    sourceRetirement: 'complete',
    cutover: { sourceCompletion: { version: 2 } }
  })
  expect(f.store.completeOrcadLiveRetirementProfile).toHaveBeenCalledOnce()
  expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
  expect(f.store.isOrcadLiveCompletionDurable).toHaveBeenCalledWith(f.journal())
  expect(
    refusal.hasExactOutgoingSourcePtyRouteRefusal(f.ids[0], f.record.identity, f.record.sha256)
  ).toBe(true)
  expect(records.readOrcadLiveSuccessorCompletionEvidence(root, f.record)).toMatchObject({
    version: 2
  })
})

it('waits for the exact profile flush before returning completion', async () => {
  const f = fixture()
  const flush = Promise.withResolvers<void>()
  f.store.flushPendingOrThrowAsync.mockReturnValue(flush.promise)
  let complete = false
  const pending = f.run().then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledOnce())
  expect(complete).toBe(false)
  expect(f.store.isOrcadLiveCompletionDurable).not.toHaveBeenCalled()
  flush.resolve()
  await pending
  expect(complete).toBe(true)
})

it('retries the exact completed journal and timestamp after a flush failure', async () => {
  const f = fixture()
  f.store.flushPendingOrThrowAsync.mockRejectedValueOnce(new Error('flush_failed'))
  await expect(f.run()).rejects.toThrow('flush_failed')
  const first = structuredClone(f.journal())
  f.now.mockReturnValue(new Date('2026-09-08T12:00:00.000Z'))
  const preparations = vi.spyOn(
    records.OrcadLiveSuccessorCompletionPreparationStore.prototype,
    'persist'
  )
  const checkpoints = vi.spyOn(records.OrcadLiveSuccessorRouteCheckpointStore.prototype, 'persist')
  await f.run()
  expect(f.journal()).toEqual(first)
  expect(preparations).toHaveBeenCalledOnce()
  expect(checkpoints).toHaveBeenCalledOnce()
  expect(f.store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
})

it('refuses unconfirmed profile durability after successful flush', async () => {
  const f = fixture()
  f.store.isOrcadLiveCompletionDurable.mockReturnValue(false)
  await expect(f.run()).rejects.toThrow('durability_unconfirmed')
})

it('rechecks route authority after the durability callback', async () => {
  const f = fixture()
  f.store.isOrcadLiveCompletionDurable.mockImplementation(() => {
    ownership.ptyOwnership.set(f.ids[0], f.targetId)
    return true
  })
  await expect(f.run()).rejects.toThrow('route_present')
  expect(ownership.ptyOwnership.get(f.ids[0])).toBe(f.targetId)
})

it.each(['cohort', 'unexpected'] as const)(
  'preserves present %s routes and refuses completion',
  async (kind) => {
    const f = fixture()
    const id = kind === 'cohort' ? f.ids[0] : toAppSshPtyId(f.targetId, 'unexpected')
    ownership.ptyOwnership.set(id, f.targetId)
    await expect(f.run()).rejects.toThrow('route_present')
    expect(ownership.ptyOwnership.get(id)).toBe(f.targetId)
    expect(f.store.completeOrcadLiveRetirementProfile).not.toHaveBeenCalled()
  }
)

it.each(['abort', 'route', 'evidence'] as const)(
  'refuses %s drift during profile flush',
  async (kind) => {
    const f = fixture()
    f.store.flushPendingOrThrowAsync.mockImplementation(async () => {
      if (kind === 'abort') {
        f.controller.abort()
      }
      if (kind === 'route') {
        ownership.ptyIncarnationById.set(toAppSshPtyId(f.targetId, 'unexpected'), 'new')
      }
      if (kind === 'evidence') {
        f.remove('orcad-live-applied-coverage-evidence')
      }
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.store.isOrcadLiveCompletionDurable).not.toHaveBeenCalled()
  }
)

it('does not write a completed journal after evidence reflush fails', async () => {
  const f = fixture()
  vi.spyOn(records.OrcadLiveSuccessorRouteCheckpointStore.prototype, 'persist').mockImplementation(
    () => {
      throw new Error('checkpoint_failed')
    }
  )
  await expect(f.run()).rejects.toThrow('checkpoint_failed')
  expect(f.store.completeOrcadLiveRetirementProfile).not.toHaveBeenCalled()
  expect(f.store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
})
