import { expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerDurableSettingsWriteTests(): void {
  it('waits for the SQLite write before returning or publishing the preference', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    const onChanged = vi.fn()
    store.onSettingsChanged(onChanged)
    let settled = false
    const pending = store.updateSettingsAndFlush(
      { alwaysForceDeleteWorktrees: true },
      { notifyListeners: true, originWebContentsId: 7 }
    )
    void pending.then(() => {
      settled = true
    })
    await started.promise
    expect(settled).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    store.updateSettings({ theme: 'dark' })
    release.resolve()
    expect((await pending).theme).toBe('dark')
    expect(readState().settings.alwaysForceDeleteWorktrees).toBe(true)
    expect(onChanged).toHaveBeenCalledWith(
      { alwaysForceDeleteWorktrees: true },
      expect.objectContaining({ alwaysForceDeleteWorktrees: true }),
      7
    )
  })

  it('rejects a failed disk write and rolls back without publishing the preference', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const previous = store.getSettings().alwaysForceDeleteWorktrees
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(new Error('Disk full'))
    const onChanged = vi.fn()
    store.onSettingsChanged(onChanged)
    await expect(
      store.updateSettingsAndFlush({ alwaysForceDeleteWorktrees: true }, { notifyListeners: true })
    ).rejects.toThrow('Disk full')
    expect(store.getSettings().alwaysForceDeleteWorktrees).toBe(previous)
    expect(readState().settings.alwaysForceDeleteWorktrees).toBe(previous)
    expect(onChanged).not.toHaveBeenCalled()
  })
}
