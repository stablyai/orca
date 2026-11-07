import { beforeEach, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../persistence/loading-store/profile-state-maintenance-fixture'

const {
  handleMock,
  setMainUiLanguageMock,
  rebuildSystemTrayMenuMock,
  applyElectronProxySettingsMock,
  applyAgentStatusHooksEnabledMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  setMainUiLanguageMock: vi.fn(),
  rebuildSystemTrayMenuMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: handleMock, on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
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
vi.mock('../browser/sessions/browser-session-proxy', () => ({
  applyBrowserSessionProxies: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../browser/sessions/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: vi.fn(() => []) }
}))
vi.mock('../window/desktop-integration/app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))
vi.mock('../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ rebuildSystemTrayMenu: rebuildSystemTrayMenuMock }))
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: setMainUiLanguageMock }))

import { registerSettingsHandlers } from './settings'

beforeEach(() => {
  handleMock.mockClear()
  setMainUiLanguageMock.mockReset().mockResolvedValue('en')
  rebuildSystemTrayMenuMock.mockClear()
  applyElectronProxySettingsMock.mockReset().mockResolvedValue({ source: 'settings' })
  applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
})

const event = { sender: { id: 1 } }

function settingsWriter() {
  const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Missing settings:set handler')
  }
  return handler
}

it('returns current settings when a language change finishes after a newer theme write', async () => {
  const { store, readState } = await createWorkerMaintenanceFixture()
  store.updateSettings({ theme: 'system', uiLanguage: 'en' })
  await store.flushPendingOrThrowAsync()
  registerSettingsHandlers(store)
  const write = settingsWriter()
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  setMainUiLanguageMock.mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return 'ko'
  })

  const first = write(event, { theme: 'dark', uiLanguage: 'ko' })
  await started.promise
  expect(rebuildSystemTrayMenuMock).not.toHaveBeenCalled()
  await write(event, { theme: 'light' })
  release.resolve()
  const reply = await first
  expect(rebuildSystemTrayMenuMock).toHaveBeenCalledOnce()
  await store.flushPendingOrThrowAsync()

  expect(store.getSettings().theme).toBe('light')
  expect(readState().settings.theme).toBe('light')
  expect(reply.theme).toBe('light')
})

it('saves canonical iroh relay settings and Automatic through the real profile store', async () => {
  const { store, readState } = await createWorkerMaintenanceFixture()
  registerSettingsHandlers(store)
  const write = settingsWriter()

  const selected = await write(event, { mobileIrohRelayUrl: ' HTTPS://Relay.Example:443 ' })
  expect(selected.mobileIrohRelayUrl).toBe('https://relay.example/')
  await store.flushPendingOrThrowAsync()
  expect(readState().settings.mobileIrohRelayUrl).toBe('https://relay.example/')

  const automatic = await write(event, { mobileIrohRelayUrl: '   ' })
  expect(automatic.mobileIrohRelayUrl).toBeNull()
  await store.flushPendingOrThrowAsync()
  expect(readState().settings.mobileIrohRelayUrl).toBeNull()
})

it.each([
  'https://private-user:private-token@relay.example/',
  'https://relay.example/private-token',
  'https://relay.example/?private-token',
  'https://relay.example/#private-token',
  'https://relay.example:',
  42
])('rejects invalid IPC relay updates without saving or leaking input: %s', async (invalid) => {
  const { store, readState } = await createWorkerMaintenanceFixture()
  store.updateSettings({ mobileIrohRelayUrl: 'https://saved.example/', theme: 'system' })
  await store.flushPendingOrThrowAsync()
  const before = readState().settings
  const changed = vi.fn()
  store.onSettingsChanged(changed)
  registerSettingsHandlers(store)

  const failure: unknown = await settingsWriter()(event, {
    mobileIrohRelayUrl: invalid,
    theme: 'dark'
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).not.toContain(String(invalid))
  expect(String(failure)).not.toContain('private-token')
  expect(store.getSettings()).toMatchObject({
    mobileIrohRelayUrl: 'https://saved.example/',
    theme: 'system'
  })
  expect(changed).not.toHaveBeenCalled()
  await store.flushPendingOrThrowAsync()
  expect(readState().settings).toEqual(before)
})

vi.mock('../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
