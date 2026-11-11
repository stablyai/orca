import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'
import type { Store } from './store'

export function registerProfileStatePtyRetirementFinalizationTests(): void {
  function assertNewSnapshotsRefused(store: Store) {
    const session = store.getWorkspaceSession()
    expect(() => store.setWorkspaceSession(session)).toThrow('blocking new terminal snapshot work')
    expect(() => store.stageWorkspaceSessionBeforeUnload(session)).toThrow(
      'blocking new terminal snapshot work'
    )
  }

  describe.each(['mutate', 'rollback'] as const)('admitted %s scope', (phase) => {
    it('preserves durable state and refuses later saves after a callback partially mutates then throws', async () => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      const original = readState()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const failure = new Error('callback failed')
      if (phase === 'rollback') {
        vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(
          new Error('disk refused')
        )
      }
      await expect(
        store.runDurableMutation(() => {
          store.updateSettings({ theme: 'dark' })
          if (phase === 'mutate') {
            throw failure
          }
          return {
            value: undefined,
            rollback: () => {
              throw failure
            }
          }
        })
      ).rejects.toBe(failure)
      assertNewSnapshotsRefused(store)
      await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
        'finalized'
      )
      await expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
      expect(readState()).toEqual(original)
    })
  })

  it('rejects an already admitted final flush after a queued callback partially mutates then throws', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    store.updateSettings({ theme: 'dark' })
    const previous = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await started.promise
    const failure = new Error('partial edit failed')
    const mutation = store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      throw failure
    })
    const rejectedMutation = expect(mutation).rejects.toBe(failure)
    const rejectedFinal = expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
    release.resolve()
    await Promise.all([previous, rejectedMutation, rejectedFinal])
    expect(readState().settings.theme).toBe('dark')
  })
}
