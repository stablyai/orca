import { beforeEach, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../persistence/loading-store/profile-state-maintenance-fixture'

const {
  handleMock,
  setMainUiLanguageMock,
  applyElectronProxySettingsMock,
  applyAgentStatusHooksEnabledMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  setMainUiLanguageMock: vi.fn(),
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
vi.mock('../ssh/ssh-config-parser', () => ({
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
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: setMainUiLanguageMock }))

import { registerSettingsHandlers } from './settings'

beforeEach(() => {
  handleMock.mockClear()
  setMainUiLanguageMock.mockReset().mockResolvedValue('en')
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
  await write(event, { theme: 'light' })
  release.resolve()
  const reply = await first
  await store.flushPendingOrThrowAsync()

  expect(store.getSettings().theme).toBe('light')
  expect(readState().settings.theme).toBe('light')
  expect(reply.theme).toBe('light')
})

it('returns current settings when hook reconciliation finishes after a newer theme write', async () => {
  const { store, readState } = await createWorkerMaintenanceFixture()
  store.updateSettings({ theme: 'system', agentStatusHooksEnabled: false })
  await store.flushPendingOrThrowAsync()
  registerSettingsHandlers(store)
  const write = settingsWriter()
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  applyAgentStatusHooksEnabledMock.mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return []
  })

  const first = write(event, { theme: 'dark', agentStatusHooksEnabled: true })
  await started.promise
  await write(event, { theme: 'light' })
  release.resolve()
  const reply = await first
  await store.flushPendingOrThrowAsync()

  expect(store.getSettings().theme).toBe('light')
  expect(readState().settings.theme).toBe('light')
  expect(reply.theme).toBe('light')
  expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ theme: 'dark' }),
    expect.any(Object)
  )
})

it('returns current settings when proxy reconciliation finishes after a newer theme write', async () => {
  const { store, readState } = await createWorkerMaintenanceFixture()
  store.updateSettings({ theme: 'system', httpProxyUrl: '' })
  await store.flushPendingOrThrowAsync()
  registerSettingsHandlers(store)
  const write = settingsWriter()
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  applyElectronProxySettingsMock.mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return { source: 'settings' }
  })

  const first = write(event, { theme: 'dark', httpProxyUrl: 'http://proxy.example:8080' })
  await started.promise
  await write(event, { theme: 'light' })
  release.resolve()
  const reply = await first
  await store.flushPendingOrThrowAsync()

  expect(store.getSettings().theme).toBe('light')
  expect(readState().settings.theme).toBe('light')
  expect(reply.theme).toBe('light')
})
