import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { createStore, testState } from '../persistence-test-harness'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'
import { liveRuntimeLifecycleFixture } from './orcad-live-runtime-lifecycle-test-fixture'
import { listSelectedOrcadLiveMigrations } from './orcad-live-migration-selection'
import { registerLiveRouteLifecycleTests } from './orcad-live-route-lifecycle-test-cases'

export function registerLiveRuntimeLifecycleTests(fixture: typeof controlReleaseFixture) {
  registerLiveRouteLifecycleTests(fixture)
  const prepare = (kind: 'folder' | 'worktree', installProfile = true) =>
    liveRuntimeLifecycleFixture(fixture, kind, installProfile)

  it.each(['folder', 'worktree'] as const)(
    'retries %s cleanup checkpoint persistence after retiring the actual source records',
    async (kind) => {
      const f = await prepare(kind)
      const prototype = OrcadLiveRuntimeCleanupCheckpointStore.prototype
      const persist = prototype.persist
      const save = vi
        .spyOn(prototype, 'persist')
        .mockImplementationOnce(function (this: OrcadLiveRuntimeCleanupCheckpointStore, value) {
          persist.call(this, value)
          throw new Error('cleanup checkpoint durability uncertain')
        })
      const dispose = vi.spyOn(
        f.runtime.inspectCleanupState().models.get(f.entries[0].ptyId)!.emulator,
        'dispose'
      )
      await expect(f.run()).rejects.toThrow('cleanup checkpoint durability uncertain')
      for (const entry of f.entries) {
        expect(f.runtime.inspectCleanupState().ptys.has(entry.ptyId)).toBe(false)
      }
      expect(
        new OrcadLiveRuntimeCleanupCheckpointStore(testState.dir).read(f.record.identity)
      ).toMatchObject({ phase: 'runtime-surfaces-removed' })
      await expect(f.run()).resolves.toMatchObject({ sourceRetirement: 'complete' })
      expect(save).toHaveBeenCalledTimes(4)
      expect(dispose).toHaveBeenCalledOnce()
      expect(f.releaseControl).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'installs the committed %s source profile before releasing controls and cleaning the actual runtime',
    async (kind) => {
      const f = await prepare(kind, false)
      expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('prepared')
      expect(f.store.getSshRemotePtyLeases(f.target.id)).toHaveLength(2)
      const release = f.releaseControl.getMockImplementation()!
      f.releaseControl.mockImplementation((value) => {
        expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
          'profile-installed'
        )
        expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
          'profile-installed'
        )
        expect(f.store.getSshRemotePtyLeases(f.target.id)).toHaveLength(0)
        release(value)
      })
      const result = await f.run()
      expect(result).toMatchObject({
        phase: 'source-retired',
        completionPreparation: { phase: 'source-completion-prepared' },
        routeCheckpoint: { phase: 'source-routes-removed' },
        sourceRetirement: 'complete'
      })
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].sourceCompletionPrepared
      ).toBe(true)
      expect(listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')).toEqual([
        {
          migrationId: f.cutover.manifest.migrationId,
          destinationEnvironmentId: 'environment',
          sourceSshTargetId: f.target.id,
          phase: 'source-retired',
          phaseEvidence: 'journal-retained',
          profileState: 'profile-installed',
          receipts: { recorded: 2, total: 2 },
          sourceRetirement: 'complete'
        }
      ])
      expect(f.releaseControl).toHaveBeenCalledTimes(2)
      for (const entry of f.entries) {
        expect(f.runtime.inspectCleanupState().models.has(entry.ptyId)).toBe(false)
        expect(f.runtime.inspectCleanupState().ptys.has(entry.ptyId)).toBe(false)
      }
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'resumes %s migration after an uncertain installed-profile flush without releasing controls early',
    async (kind) => {
      const f = await prepare(kind, false)
      const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
      let failed = false
      let reflushConfirmed = false
      vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
        await flush(options)
        if (
          !failed &&
          f.store.inspectOrcadLiveRetirementProfileState(f.record).state === 'profile-installed'
        ) {
          failed = true
          throw new Error('installed profile durability uncertain')
        }
        if (
          f.store.inspectOrcadLiveRetirementProfileState(f.record).state === 'profile-installed'
        ) {
          reflushConfirmed = true
        }
      })
      await expect(f.run()).rejects.toThrow('installed profile durability uncertain')
      expect(failed).toBe(true)
      expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
        'profile-installed'
      )
      expect(f.releaseControl).not.toHaveBeenCalled()
      expect(reflushConfirmed).toBe(false)
      for (const entry of f.entries) {
        expect(f.runtime.inspectCleanupState().models.has(entry.ptyId)).toBe(true)
      }
      const release = f.releaseControl.getMockImplementation()!
      f.releaseControl.mockImplementation((value) => {
        expect(reflushConfirmed).toBe(true)
        release(value)
      })
      await expect(f.run()).resolves.toMatchObject({ sourceRetirement: 'complete' })
      expect(f.releaseControl).toHaveBeenCalledTimes(2)
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBe(true)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'retires actual %s source records under installed-profile authority without exiting live processes',
    async (kind) => {
      const f = await prepare(kind)
      const state = f.runtime.inspectCleanupState()
      const records = f.entries.map(({ ptyId }) => state.ptys.get(ptyId))
      const before = structuredClone(records)
      const otherModel = state.models.get(f.other.ptyId)
      const otherSnapshot = state.mobile.get(f.other.worktreeId)
      const exit = vi.spyOn(f.runtime, 'onPtyExit')
      await f.run()
      const sourceIdentity = vi
        .spyOn(f.provider, 'getOwnershipTransferSourceIdentity')
        .mockClear()
        .mockImplementation(() => {
          throw new Error('original source provider unavailable')
        })
      await f.run(undefined, true)
      expect(sourceIdentity).not.toHaveBeenCalled()
      const absence = f.runtime.bindOutgoingSshPtySurfaceAbsence(
        f.target.id,
        f.entries.map((entry, index) => ({
          ptyId: entry.ptyId,
          surfaceBinding: f.cutover.liveTerminalBindings![index].surfaceBinding
        }))
      )
      expect(() => absence.assertAbsent()).not.toThrow()
      for (const [index, entry] of f.entries.entries()) {
        expect(state.models.has(entry.ptyId)).toBe(false)
        expect(state.handles.has(entry.ptyId)).toBe(false)
        expect([...state.leaves.values()].some((leaf) => leaf.ptyId === entry.ptyId)).toBe(false)
        expect(state.ptys.has(entry.ptyId)).toBe(false)
        expect(records[index]).toEqual(before[index])
        expect(state.mobile.get(entry.worktreeId)?.tabs).toEqual([])
      }
      expect(state.models.get(f.other.ptyId)).toBe(otherModel)
      expect(state.mobile.get(f.other.worktreeId)).toBe(otherSnapshot)
      expect(exit).not.toHaveBeenCalled()
      expect(f.mux.dispose).not.toHaveBeenCalled()
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBe(true)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'resumes actual %s model disposal with a fresh signal after cancellation between disposal and graph removal',
    async (kind) => {
      const f = await prepare(kind)
      const state = f.runtime.inspectCleanupState()
      const first = f.entries[0].ptyId
      const model = state.models.get(first)!
      const controller = new AbortController()
      const original = model.emulator.dispose.bind(model.emulator)
      const dispose = vi.spyOn(model.emulator, 'dispose').mockImplementation(() => {
        original()
        controller.abort(new Error('cancel after disposal'))
      })
      await expect(f.run(controller.signal)).rejects.toThrow('cancel after disposal')
      expect(state.handles.has(first)).toBe(true)
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBeUndefined()
      await f.run()
      expect(dispose).toHaveBeenCalledOnce()
      expect(state.models.has(first)).toBe(false)
      expect(state.handles.has(first)).toBe(false)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'retries actual %s emulator failure without settling or disposing completed ownership again',
    async (kind) => {
      const f = await prepare(kind)
      const state = f.runtime.inspectCleanupState()
      const first = f.entries[0].ptyId
      const model = state.models.get(first)!
      const ownership = vi.spyOn(model.ownership, 'dispose')
      const settle = vi.spyOn(model.ownership, 'settle')
      const disable = vi.spyOn(model.emulator, 'disableQueryReplyForwarding')
      const dispose = vi.spyOn(model.emulator, 'dispose').mockImplementationOnce(() => {
        throw new Error('emulator disposal failed')
      })
      const exit = vi.spyOn(f.runtime, 'onPtyExit')
      await expect(f.run()).rejects.toThrow('emulator disposal failed')
      expect(ownership).toHaveBeenCalledOnce()
      const settledBeforeRetry = settle.mock.calls.length
      expect(state.models.get(first)).toBe(model)
      expect(state.handles.has(first)).toBe(true)
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBeUndefined()
      await f.run()
      expect(settle).toHaveBeenCalledTimes(settledBeforeRetry)
      expect(ownership).toHaveBeenCalledOnce()
      expect(disable).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledTimes(2)
      expect(state.models.has(first)).toBe(false)
      expect(state.handles.has(first)).toBe(false)
      expect(exit).not.toHaveBeenCalled()
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBe(true)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'refuses provider replacement while actual %s cleanup is settling a model',
    async (kind) => {
      const f = await prepare(kind)
      const state = f.runtime.inspectCleanupState()
      const first = f.entries[0].ptyId
      const model = state.models.get(first)!
      const original = model.ownership.settle.bind(model.ownership)
      const pending = Promise.withResolvers<void>()
      const settle = vi.spyOn(model.ownership, 'settle')
      settle.mockImplementationOnce(original).mockImplementationOnce(() => pending.promise)
      const dispose = vi.spyOn(model.emulator, 'dispose')
      const exit = vi.spyOn(f.runtime, 'onPtyExit')
      const running = f.run()
      const refused = expect(running).rejects.toThrow('source_authority_changed')
      await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(2))
      Object.defineProperty(f.provider, 'providerGeneration', { value: 2 })
      pending.resolve()
      await refused
      expect(dispose).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
      expect(state.models.get(first)).toBe(model)
      expect(state.handles.has(first)).toBe(true)
      expect(
        inspectOrcadLiveRetirementRecovery(testState.dir, f.store)[0].runtimeCleanupRecorded
      ).toBeUndefined()
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'retries actual %s snapshot notification failure without redisposal or another snapshot version',
    async (kind) => {
      const f = await prepare(kind)
      const state = f.runtime.inspectCleanupState()
      const dispose = vi.spyOn(state.models.get(f.entries[0].ptyId)!.emulator, 'dispose')
      let initialVersion = -1
      const prepareCleanup = f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup.bind(f.runtime)
      vi.spyOn(f.runtime, 'prepareOutgoingSshPtyGraphAndModelCleanup').mockImplementation(
        (targetId) => {
          initialVersion = state.mobile.get(f.entries[0].worktreeId)!.snapshotVersion!
          return prepareCleanup(targetId)
        }
      )
      const listener = vi.fn().mockImplementationOnce(() => {
        throw new Error('snapshot consumer failed')
      })
      const unsubscribe = f.runtime.onMobileSessionTabsChanged(listener)
      try {
        await expect(f.run()).rejects.toThrow('snapshot consumer failed')
        const snapshot = state.mobile.get(f.entries[0].worktreeId)
        await f.run()
        expect(state.mobile.get(f.entries[0].worktreeId)).toBe(snapshot)
        expect(dispose).toHaveBeenCalledOnce()
        expect(listener).toHaveBeenCalledTimes(2)
        expect(listener.mock.calls.map(([value]) => value.snapshotVersion)).toEqual([
          initialVersion + f.entries.length,
          initialVersion + f.entries.length
        ])
      } finally {
        unsubscribe()
      }
    }
  )
}
