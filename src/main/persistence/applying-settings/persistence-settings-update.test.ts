import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../../workspaces/catalog/local-worktree-scan-generation'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('invalidates local worktree scans when the global Windows runtime changes', async () => {
    writeDataFile({ repos: [makeRepo()] })
    const store = await createStore()
    const generation = getLocalWorktreeScanGeneration('r1')

    store.updateSettings({ theme: 'dark' })
    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(true)

    store.updateSettings({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(false)
  })

  it('saves a pasted workspace directory with leading spaces as the absolute path it names', async () => {
    const store = await createStore()
    store.updateSettings({ workspaceDir: '/Users/me/dev' })
    const historyBefore = store.getSettings().workspaceDirHistory

    // Padding before an absolute path would otherwise resolve inside every repo.
    expect(store.updateSettings({ workspaceDir: '  /Users/me/dev' }).workspaceDir).toBe(
      '/Users/me/dev'
    )
    expect(store.getSettings().workspaceDirHistory).toEqual(historyBefore)
    // Trailing characters and relative paths can be real folder names.
    expect(store.updateSettings({ workspaceDir: '/tmp/workspaces ' }).workspaceDir).toBe(
      '/tmp/workspaces '
    )
    expect(store.updateSettings({ workspaceDir: ' ~notes' }).workspaceDir).toBe(' ~notes')
    if (process.platform === 'win32') {
      expect(store.updateSettings({ workspaceDir: ' C:\\work' }).workspaceDir).toBe('C:\\work')
    } else {
      // ~\ and a leading \ are relative off Windows, so the value stays exact.
      expect(store.updateSettings({ workspaceDir: ' ~\\work' }).workspaceDir).toBe(' ~\\work')
      expect(store.updateSettings({ workspaceDir: ' \\work' }).workspaceDir).toBe(' \\work')
    }
  })

  it('updateSettings deep-merges and clamps notification custom sound volume', async () => {
    const store = await createStore()
    store.updateSettings({
      notifications: {
        ...store.getSettings().notifications,
        enabled: false,
        customSoundPath: '/sounds/custom.wav'
      }
    })
    const updated = store.updateSettings({
      // @ts-expect-error -- Partial notification patches can arrive from older clients.
      notifications: { customSoundVolume: -20 }
    })

    expect(updated.notifications.customSoundVolume).toBe(0)
    expect(updated.notifications.enabled).toBe(false)
    expect(updated.notifications.customSoundPath).toBe('/sounds/custom.wav')
  })

  it('hides IBM Bob on existing profiles once', async () => {
    writeDataFile({
      settings: { claudeAgentTeamsDefaultDisabledMigrated: true, disabledTuiAgents: [] }
    })
    const store = await createStore()
    expect(store.getSettings().disabledTuiAgents).toEqual(['bob'])
    expect(store.getSettings().bobDefaultDisabledMigrated).toBe(true)
  })

  it('respects an explicit IBM Bob opt-in after the hide migration ran', async () => {
    writeDataFile({
      settings: {
        claudeAgentTeamsDefaultDisabledMigrated: true,
        bobDefaultDisabledMigrated: true,
        disabledTuiAgents: []
      }
    })
    const store = await createStore()
    expect(store.getSettings().disabledTuiAgents).toEqual([])
  })
})
