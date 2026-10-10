import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { profileStateJsonExportPaths } from '../profile-state/legacy-json/profile-state-export-path'
import { createWorkerMaintenanceFixture } from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('SQLite profile state during an update quit', () => {
  it.each(['best-effort', 'strict'] as const)(
    'persists final SSH and getter mutations without publishing JSON (%s)',
    async (kind) => {
      const { store, dataFile, readState } = await createWorkerMaintenanceFixture()
      store.upsertSshRemotePtyLease({
        targetId: 'remote-host',
        ptyId: 'remote-pty',
        state: 'attached'
      })
      await store.writeLatestProfileStateJsonExportAsync()
      const retainedPaths = profileStateJsonExportPaths(dataFile)
      const retainedBytes = retainedPaths.map((path) => readFileSync(path, 'utf8'))
      store.updateSettings({ theme: 'dark' })
      store.getWorkspaceSession().activeTabId = 'last-tab'
      store.markSshRemotePtyLeasesForShutdown('remote-host', 'detached')

      await (kind === 'strict' ? store.flushFinalOrThrowAsync() : store.flushAsync())

      expect(readState()).toMatchObject({
        settings: { theme: 'dark' },
        workspaceSession: { activeTabId: 'last-tab' },
        sshRemotePtyLeases: expect.arrayContaining([
          expect.objectContaining({ targetId: 'remote-host', state: 'detached' })
        ])
      })
      expect(existsSync(dataFile)).toBe(false)
      expect(profileStateJsonExportPaths(dataFile)).toEqual(retainedPaths)
      expect(retainedPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(retainedBytes)
    }
  )

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
