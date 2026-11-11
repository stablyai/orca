import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getActiveViewPreferenceFile } from '../preferences/active-view-preference'
import { profileStateJsonExportPaths } from '../profile-state/legacy-json/profile-state-export-path'
import {
  createSqliteMaintenanceFixture,
  createWorkerMaintenanceFixture
} from './profile-state-maintenance-fixture'

export function registerProfileStateMaintenanceTests(): void {
  describe('profile maintenance admission', () => {
    it('refuses re-admission after a competing write without adopting its revision', async () => {
      const { store, peer, readState } = await createWorkerMaintenanceFixture()
      store.updateSettings({ theme: 'dark' })
      const maintenance = await store.beginProfileMaintenance()
      const writer = peer()
      try {
        writer.readSerializedState()
        writer.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
      } finally {
        writer.close()
      }
      await expect(maintenance.resume()).rejects.toThrow('Profile state revision changed')
      const mutate = vi.fn(() => ({ value: undefined }))
      await expect(store.runDurableMutation(mutate)).rejects.toThrow('finalized')
      expect(mutate).not.toHaveBeenCalled()
      expect(readState().peer).toEqual({ preserved: true })
    })

    it('quarantines a faulted worker only after closing it, without writing current memory', async () => {
      const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
      const durable = readState()
      store.updateSettings({ theme: durable.settings.theme === 'dark' ? 'light' : 'dark' })
      await authority.abort()
      const result = await store.quarantineProfileStateDatabaseAsync(directory, 'worker-failure')
      expect(result.copiedFiles.some((path) => path.endsWith('profile-state.db'))).toBe(true)
      expect(readState()).toEqual(durable)
      await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    })

    it('pauses SQLite and preference timers, then persists edits after unchanged-source resume', async () => {
      const { store, dataFile, authority } = createSqliteMaintenanceFixture()
      const maintenance = await store.beginProfileMaintenance()
      const before = authority.readSerializedState()
      const preference = getActiveViewPreferenceFile(dataFile)
      const preferenceBefore = readFileSync(preference)
      vi.useFakeTimers()
      try {
        store.updateSettings({ theme: 'dark' })
        store.updateUI({ activeView: 'settings' })
        await vi.advanceTimersByTimeAsync(6_000)
        expect(authority.readSerializedState()).toEqual(before)
        expect(readFileSync(preference)).toEqual(preferenceBefore)
      } finally {
        vi.useRealTimers()
      }
      await maintenance.resume()
      await store.flushPendingOrThrowAsync()
      expect(JSON.parse(authority.readSerializedState() ?? '{}').settings.theme).toBe('dark')
      expect(JSON.parse(readFileSync(preference, 'utf8')).activeView).toBe('settings')
    })
  })
}

export function registerProfileStateMaintenanceCompatibilityTests(): void {
  it('checkpoints SQL without publishing JSON or rewriting explicit exports', async () => {
    const { store, dataFile, readState } = await createWorkerMaintenanceFixture()
    await store.writeLatestProfileStateJsonExportAsync()
    const retainedPaths = profileStateJsonExportPaths(dataFile)
    const retainedBytes = retainedPaths.map((path) => readFileSync(path, 'utf8'))
    store.updateSettings({ theme: 'dark' })
    store.getWorkspaceSession().activeTabId = 'latest-tab'

    const maintenance = await store.beginProfileMaintenance()

    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: 'latest-tab' }
    })
    expect(existsSync(dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(dataFile)).toEqual(retainedPaths)
    expect(retainedPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(retainedBytes)
    await maintenance.resume()
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState().settings.theme).toBe('light')
  })

  it('preserves the existing SQL state and publishes no JSON during a recovery pause', async () => {
    const { store, dataFile, readState } = await createWorkerMaintenanceFixture()
    const before = readState()
    store.updateSettings({ theme: 'dark' })

    await store.beginProfileMaintenance({ flush: false })

    expect(readState()).toEqual(before)
    expect(existsSync(dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(dataFile)).toEqual([])
  })
}
