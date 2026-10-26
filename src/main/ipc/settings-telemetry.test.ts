import { expect, it, vi } from 'vitest'

const {
  handleMock,
  setMainUiLanguageMock,
  rebuildSystemTrayMenuMock,
  applyElectronProxySettingsMock,
  applyAgentStatusHooksEnabledMock,
  trackMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  setMainUiLanguageMock: vi.fn(),
  rebuildSystemTrayMenuMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: handleMock, on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../ghostty/index', () => ({ previewGhosttyImport: vi.fn() }))
vi.mock('../warp-themes', () => ({ previewWarpThemeImport: vi.fn() }))
vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyElectronProxySettingsMock
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
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ rebuildSystemTrayMenu: rebuildSystemTrayMenuMock }))
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: setMainUiLanguageMock }))

import { registerSettingsHandlers } from './settings'

it('records Agent Dashboard enablement only for a real setting transition', async () => {
  const store = {
    getSettings: vi.fn(() => ({ experimentalAgentDashboardPopout: false })),
    updateSettings: vi.fn(() => ({ experimentalAgentDashboardPopout: true })),
    onSettingsChanged: vi.fn(() => () => {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler only uses the settings methods supplied by the fixture.
  registerSettingsHandlers(store as never)
  const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Missing settings:set handler')
  }

  await handler({ sender: { id: 1 } }, { experimentalAgentDashboardPopout: true })

  expect(trackMock).toHaveBeenCalledWith('agent_dashboard_enabled', { enabled: true })

  trackMock.mockClear()
  store.getSettings.mockReturnValue({ experimentalAgentDashboardPopout: true })
  await handler({ sender: { id: 1 } }, { experimentalAgentDashboardPopout: true })
  expect(trackMock).not.toHaveBeenCalled()
})

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
