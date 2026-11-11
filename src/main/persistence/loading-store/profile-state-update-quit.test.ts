import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { profileStateJsonExportPaths } from '../profile-state/legacy-json/profile-state-export-path'
import { createWorkerMaintenanceFixture } from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('SQLite profile state during an update quit', () => {
  it('preserves the prior durable state when final persistence fails', async () => {
    const { store, authority, dataFile, readState } = await createWorkerMaintenanceFixture()
    const before = readState()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(
      new Error('injected final commit failure')
    )
    store.updateSettings({ theme: 'dark' })

    await store.flushAsync()

    expect(readState()).toEqual(before)
    expect(existsSync(dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(dataFile)).toEqual([])
  })
})
