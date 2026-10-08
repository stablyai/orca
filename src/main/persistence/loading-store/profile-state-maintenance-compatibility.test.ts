import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerMaintenanceFixture } from './profile-state-maintenance-fixture'
import { profileStateJsonExportPaths } from '../profile-state/legacy-json/profile-state-export-path'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('profile maintenance without compatibility snapshots', () => {
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
})
