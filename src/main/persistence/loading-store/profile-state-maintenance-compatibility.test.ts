import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerMaintenanceFixture } from './profile-state-maintenance-fixture'
import { profileStateJsonExportPaths } from '../profile-state/profile-state-export-path'
import { openProfileStateDatabase } from '../profile-state/profile-state-database'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('maintenance compatibility checkpoint', () => {
  it('exports the current worker state before a clean profile switch releases its writer', async () => {
    const { store, dataFile, readState } = await createWorkerMaintenanceFixture()
    expect(existsSync(dataFile)).toBe(false)
    store.updateSettings({ theme: 'dark' })
    store.getWorkspaceSession().activeTabId = 'latest-tab'
    const maintenance = await store.beginProfileMaintenance()
    const snapshot = JSON.parse(readFileSync(dataFile, 'utf8'))
    expect(snapshot).toEqual(readState())
    expect(snapshot.settings.theme).toBe('dark')
    expect(snapshot.workspaceSession.activeTabId).toBe('latest-tab')
    const [retained] = profileStateJsonExportPaths(dataFile)
    expect(JSON.parse(readFileSync(retained, 'utf8'))).toEqual(snapshot)
    await maintenance.resume()
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState().settings.theme).toBe('light')
  })

  it('does not publish compatibility files for a recovery pause', async () => {
    const { store, dataFile } = await createWorkerMaintenanceFixture()
    store.updateSettings({ theme: 'dark' })
    await store.beginProfileMaintenance({ flush: false })
    expect(existsSync(dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(dataFile)).toEqual([])
  })

  it('resumes admission after a known export failure while preserving the committed state', async () => {
    const { store, authority, dataFile, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(authority, 'writeJsonCompatibilityExportAsync').mockRejectedValueOnce(
      new Error('export disk refused')
    )
    store.updateSettings({ theme: 'dark' })
    await expect(store.beginProfileMaintenance()).rejects.toThrow('export disk refused')
    expect(existsSync(dataFile)).toBe(false)
    expect(readState().settings.theme).toBe('dark')
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState().settings.theme).toBe('light')
    await (await store.beginProfileMaintenance()).resume()
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('light')
  })

  it('resumes after the worker cannot read JSON before staging compatibility acceptance', async () => {
    const { store, dataFile, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(dataFile)
    store.updateSettings({ theme: 'dark' })

    await expect(store.beginProfileMaintenance()).rejects.toMatchObject({
      outcome: 'known-failure'
    })
    expect(readState().settings.theme).toBe('dark')
    rmSync(dataFile, { recursive: true })
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState().settings.theme).toBe('light')
    await (await store.beginProfileMaintenance()).resume()
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('light')
  })

  it.each(['maintenance', 'update-preflight'] as const)(
    'resumes saving after a rolled-back %s export leaves both JSON versions accepted',
    async (phase) => {
      const { store, authority, dataFile, databaseFile, profileId, readState } =
        await createWorkerMaintenanceFixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await authority.writeJsonCompatibilityExportAsync(dataFile)
      const opened = openProfileStateDatabase(databaseFile, profileId)
      try {
        opened.db.exec(`
        CREATE TRIGGER reject_acceptance BEFORE INSERT ON profile_state_meta
        WHEN NEW.key = 'legacy_json_acceptance'
          AND json_type(NEW.value, '$.pending') IS NULL
        BEGIN SELECT RAISE(ABORT, 'injected promotion failure'); END
      `)
      } finally {
        opened.db.close()
      }
      store.updateSettings({ theme: 'dark' })

      await expect(
        phase === 'maintenance'
          ? store.beginProfileMaintenance()
          : store.writeLatestProfileStateJsonCompatibilityExportAsync()
      ).rejects.toMatchObject({ outcome: 'known-failure' })
      expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('dark')
      expect(readState().settings.theme).toBe('dark')
      await store.runDurableMutation(() => {
        store.updateSettings({ theme: 'light' })
        return { value: undefined }
      })
      expect(readState().settings.theme).toBe('light')
      const repaired = openProfileStateDatabase(databaseFile, profileId)
      try {
        repaired.db.exec('DROP TRIGGER reject_acceptance')
      } finally {
        repaired.db.close()
      }
      await (await store.beginProfileMaintenance()).resume()
      expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('light')
    }
  )
})
