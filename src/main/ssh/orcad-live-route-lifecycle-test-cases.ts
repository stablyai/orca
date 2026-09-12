import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { testState } from '../persistence-test-harness'
import { liveRuntimeLifecycleFixture } from './orcad-live-runtime-lifecycle-test-fixture'
import { ptyOwnership, ptyIncarnationById } from '../ipc/pty/provider/ownership-state'
import { assertOutgoingSourcePtyRouteAllowed } from '../ipc/pty/provider/outgoing-source-route-refusal'
import {
  OrcadLiveSourceRouteCheckpointStore,
  listValidatedOrcadLiveSourceRouteCheckpoints
} from './orcad-live-source-route-checkpoint'
import { OrcadLiveSourceCompletionPreparationStore } from './orcad-live-source-completion-preparation'

export function registerLiveRouteLifecycleTests(fixture: typeof controlReleaseFixture) {
  it.each(['folder', 'worktree'] as const)(
    'retries uncertain %s route checkpoint persistence only through explicit recovery',
    async (kind) => {
      const f = await liveRuntimeLifecycleFixture(fixture, kind)
      const prototype = OrcadLiveSourceRouteCheckpointStore.prototype
      const original = prototype.persist
      const save = vi
        .spyOn(prototype, 'persist')
        .mockImplementationOnce(function (this: OrcadLiveSourceRouteCheckpointStore, value) {
          original.call(this, value)
          throw new Error('route checkpoint durability uncertain')
        })
      await expect(f.run()).rejects.toThrow('route checkpoint durability uncertain')
      for (const entry of f.entries) {
        expect(ptyOwnership.has(entry.ptyId)).toBe(false)
        expect(ptyIncarnationById.has(entry.ptyId)).toBe(false)
        expect(() => assertOutgoingSourcePtyRouteAllowed(entry.ptyId)).toThrow(
          'source_control_released'
        )
      }
      expect(
        new OrcadLiveSourceRouteCheckpointStore(testState.dir).read(f.record.identity)
      ).toMatchObject({
        phase: 'source-routes-removed'
      })
      await expect(f.run()).rejects.toThrow('route_changed')
      const result = await f.run(undefined, true)
      expect(result).toMatchObject({
        phase: 'source-retired',
        sourceRetirement: 'complete',
        completionEvidence: {
          version: 1,
          retirementRecordSha256: f.record.sha256,
          sourceRouteCheckpointSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        routeCheckpoint: { phase: 'source-routes-removed' }
      })
      expect(listValidatedOrcadLiveSourceRouteCheckpoints(testState.dir)).toHaveLength(1)
      expect(save).toHaveBeenCalledTimes(3)
      expect(f.mux.dispose).not.toHaveBeenCalled()
      expect(f.releaseControl).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['folder', 'worktree'] as const)(
    'refuses recovery with existing %s routes and removes them only on initial retirement',
    async (kind) => {
      const f = await liveRuntimeLifecycleFixture(fixture, kind)
      const prototype = OrcadLiveSourceCompletionPreparationStore.prototype
      const original = prototype.persist
      vi.spyOn(prototype, 'persist').mockImplementationOnce(
        function (this: OrcadLiveSourceCompletionPreparationStore, value) {
          original.call(this, value)
          throw new Error('completion preparation durability uncertain')
        }
      )
      await expect(f.run()).rejects.toThrow('completion preparation durability uncertain')
      await expect(f.run(undefined, true)).rejects.toThrow('route_present')
      for (const [index, entry] of f.entries.entries()) {
        expect(ptyOwnership.get(entry.ptyId)).toBe(f.target.id)
        expect(ptyIncarnationById.get(entry.ptyId)).toBe(
          f.cutover.liveTerminalBindings![index].identity.incarnationId
        )
      }
      expect(
        new OrcadLiveSourceRouteCheckpointStore(testState.dir).read(f.record.identity)
      ).toBeNull()
      await expect(f.run()).resolves.toMatchObject({
        routeCheckpoint: { phase: 'source-routes-removed' },
        sourceRetirement: 'complete'
      })
    }
  )
}
