const sanitizeDirectoryMock: Mock = vi.hoisted(() => vi.fn())
vi.mock('./floating-workspace-directory', () => ({
  sanitizeFloatingWorkspaceDirectorySetting: sanitizeDirectoryMock
}))
const confirmBrowserPasswordOwnerMock: Mock = vi.hoisted(() => vi.fn())
vi.mock('../browser-passwords/browser-password-reauth', () => ({
  confirmBrowserPasswordOwner: confirmBrowserPasswordOwnerMock
}))
import { vi, type Mock } from 'vitest'

const {
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  reconcileClaudeAgentViewMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  listEnvironmentsMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  applySessionSearchSettingsChangeMock,
  listProfilesMock
} = vi.hoisted((): Record<string, Mock> => ({
  applyAppIconMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn(),
  reconcileClaudeAgentViewMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  prepareLocalWorktreeRootsForReposMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  applyBrowserSessionProxiesMock: vi.fn(),
  applySessionSearchSettingsChangeMock: vi.fn(),
  listProfilesMock: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  ipcMain: { handle: handleMock, on: onMock },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('../ghostty/index', () => ({
  previewGhosttyImport: previewGhosttyImportMock
}))

vi.mock('../warp-themes', () => ({
  previewWarpThemeImport: previewWarpThemeImportMock
}))

vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyElectronProxySettingsMock
}))

vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: applyBrowserSessionProxiesMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: listProfilesMock }
}))

vi.mock('../app-icon', () => ({
  applyAppIcon: applyAppIconMock
}))

vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: applySessionSearchSettingsChangeMock
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: reconcileClaudeAgentViewMock })
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: prepareLocalWorktreeRootsForReposMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock,
  listEnvironments: listEnvironmentsMock
}))

const settingsInvokeEvent = { sender: { id: 1 } }
export type SettingsChangedListener = (
  updates: unknown,
  settings: unknown,
  originWebContentsId?: number
) => void

const store: Record<string, Mock> = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSettingsAndFlush: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

export {
  sanitizeDirectoryMock,
  confirmBrowserPasswordOwnerMock,
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  reconcileClaudeAgentViewMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  listEnvironmentsMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  applySessionSearchSettingsChangeMock,
  listProfilesMock,
  settingsInvokeEvent,
  store
}
