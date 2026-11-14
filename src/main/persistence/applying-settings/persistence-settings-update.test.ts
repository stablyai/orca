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

  it('repairs workspace cleanup rules when loading and when writing', async () => {
    writeDataFile({
      settings: {
        workspaceCleanupPolicy: { merged: { enabled: true }, unchanged: { afterDays: -4 } }
      },
      repos: [
        { ...makeRepo({ id: 'r1' }), workspaceCleanupPolicy: { mode: 'off', extra: 1 } },
        { ...makeRepo({ id: 'r2', path: '/repo2' }), workspaceCleanupPolicy: { mode: 'sometimes' } }
      ]
    })
    const store = await createStore()
    const offRules = {
      merged: { enabled: false },
      unchanged: { enabled: false, afterDays: 1 },
      inactive: { enabled: false, afterDays: 30, action: 'archive' },
      automationRuns: { enabled: false },
      orchestrationWorkers: { enabled: false },
      keepWhen: 'any-local-files'
    }
    expect(store.getSettings().workspaceCleanupPolicy).toEqual({
      ...offRules,
      merged: { enabled: true }
    })
    expect(store.getRepo('r1')?.workspaceCleanupPolicy).toEqual({ mode: 'off' })
    expect(store.getRepo('r2')).not.toHaveProperty('workspaceCleanupPolicy')

    store.updateSettings({
      // @ts-expect-error -- Malformed writes can arrive from untyped writers.
      workspaceCleanupPolicy: { inactive: { enabled: true, action: 'delete', afterDays: 'soon' } }
    })
    expect(store.getSettings().workspaceCleanupPolicy).toEqual({
      ...offRules,
      inactive: { enabled: true, afterDays: 30, action: 'delete' }
    })

    store.updateRepo({ id: 'r1' }, { workspaceCleanupPolicy: null })
    expect(store.getRepo('r1')).not.toHaveProperty('workspaceCleanupPolicy')
  })
})
