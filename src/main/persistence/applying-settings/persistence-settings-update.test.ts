import { closeTestStores, testState, createStore } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

  it('reports every applied settings change with its origin, even when listeners are not notified', async () => {
    const store = await createStore()
    const persisted: { changed: Record<string, unknown>; origin: string | undefined }[] = []
    store.onSettingsPersisted((changed, origin) => persisted.push({ changed, origin }))

    store.updateSettings({ theme: 'dark' })
    await store.updateSettingsAndFlush({ terminalFontSize: 21 }, { origin: 'settings-file' })
    store.updateSettings({ theme: 'dark' })

    expect(persisted).toEqual([
      { changed: { theme: 'dark' }, origin: undefined },
      { changed: { terminalFontSize: 21 }, origin: 'settings-file' }
    ])
  })

  it('reports the sibling a durable update derives, so the settings file gets it too', async () => {
    const store = await createStore()
    const persisted: Record<string, unknown>[] = []
    store.onSettingsPersisted((changed) => persisted.push(changed))

    await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'open' })

    expect(persisted).toEqual([
      { terminalLinkClickBehavior: 'open', terminalLinkActionPopoverEnabled: false }
    ])
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
})
