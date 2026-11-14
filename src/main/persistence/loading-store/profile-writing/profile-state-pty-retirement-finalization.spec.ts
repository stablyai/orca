import { expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerProfileStatePtyRetirementFinalizationTests(): void {
  it('rejects an already admitted final flush after a queued callback partially mutates then throws', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writePreparedState.bind(authority)
    vi.spyOn(authority, 'writePreparedState').mockImplementationOnce(async (domains) => {
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
