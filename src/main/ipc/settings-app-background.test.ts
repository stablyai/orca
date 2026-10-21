import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkerMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: handleMock, on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../ghostty/index', () => ({ previewGhosttyImport: vi.fn() }))
vi.mock('../warp-themes', () => ({ previewWarpThemeImport: vi.fn() }))
vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: vi.fn().mockResolvedValue({ source: 'settings' })
}))
vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: vi.fn(() => []) }
}))
vi.mock('../app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn().mockResolvedValue([])
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ rebuildSystemTrayMenu: vi.fn() }))
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: vi.fn().mockResolvedValue('en') }))

import { registerSettingsHandlers } from './settings'

beforeEach(() => {
  handleMock.mockClear()
})

function settingsWriter() {
  const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Missing settings:set handler')
  }
  return handler
}

it('does not let the renderer write the background image id and clamps background values', async () => {
  const { store } = await createWorkerMaintenanceFixture()
  registerSettingsHandlers(store)

  await settingsWriter()(
    { sender: { id: 1 } },
    {
      appBackgroundImageId: '../../etc/passwd',
      appBackgroundBlur: 99,
      appBackgroundScope: 'workspace'
    }
  )

  const settings = store.getSettings()
  expect(settings.appBackgroundImageId ?? null).toBeNull()
  expect(settings.appBackgroundBlur).toBe(20)
  expect(settings.appBackgroundScope).toBe('workspace')
})
