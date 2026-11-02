import { describe, expect, it, vi, beforeEach } from 'vitest'

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
} = vi.hoisted(() => ({
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

vi.mock('../claude/agent-view/agent-view-service', () => ({
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

import { registerSettingsHandlers } from './settings'

const settingsInvokeEvent = { sender: { id: 1 } }

const store = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSettingsAndFlush: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    store.updateSettingsAndFlush.mockReset()
    onMock.mockClear()
    applyAppIconMock.mockClear()
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
    reconcileClaudeAgentViewMock.mockReset().mockResolvedValue(undefined)
    applyElectronProxySettingsMock.mockClear()
    applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
    previewGhosttyImportMock.mockClear()
    previewWarpThemeImportMock.mockClear()
    prepareLocalWorktreeRootsForReposMock.mockReset().mockResolvedValue(undefined)
    resolveEnvironmentMock.mockReset().mockImplementation((_userDataPath, selector) => {
      if (selector !== 'windows-2' && selector !== 'Windows 2') {
        throw new Error('Runtime environment not found')
      }
      return { id: 'windows-2' }
    })
    rebuildAppMenuMock.mockClear()
    applyBrowserSessionProxiesMock.mockReset().mockResolvedValue(undefined)
    applySessionSearchSettingsChangeMock.mockClear()
    listProfilesMock.mockReset().mockReturnValue([])
    browserWindowGetAllWindowsMock.mockReset()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.onSettingsChanged.mockClear()
    listEnvironmentsMock.mockReset().mockReturnValue([])
  })

  it('repairs removed Active Server preferences on asynchronous and synchronous reads', () => {
    store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: 'removed' })
    store.updateSettings.mockImplementation((updates) => {
      const next = { ...store.getSettings(), ...updates }
      store.getSettings.mockReturnValue(next)
      return next
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler only uses the settings methods supplied by the fixture.
    registerSettingsHandlers(store as never)
    const get = handleMock.mock.calls.find(([channel]) => channel === 'settings:get')?.[1]
    const getSync = onMock.mock.calls.find(([channel]) => channel === 'settings:get-sync')?.[1]

    expect(get()).toEqual({ activeRuntimeEnvironmentId: null })
    store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: 'removed-again' })
    const event = { returnValue: undefined }
    getSync(event)
    expect(event.returnValue).toEqual({ activeRuntimeEnvironmentId: null })
    expect(store.updateSettings).toHaveBeenCalledTimes(2)
    expect(listEnvironmentsMock).toHaveBeenCalledWith('/test/user-data', { requireStoreFile: true })
  })

  it('rejects durable Active Server writes through generic settings:set', async () => {
    store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: null })
    store.updateSettings.mockReturnValue({ activeRuntimeEnvironmentId: null })
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { activeRuntimeEnvironmentId: string }
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { activeRuntimeEnvironmentId: 'windows-2' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ originWebContentsId: 1 })
    )
  })

  it('propagates a failed durable force-delete preference write through settings:set', async () => {
    store.getSettings.mockReturnValue({ alwaysForceDeleteWorktrees: false })
    store.updateSettingsAndFlush.mockRejectedValue(new Error('Disk full'))
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1]
    if (typeof handler !== 'function') {
      throw new Error('Missing settings:set handler')
    }
    await expect(
      handler(settingsInvokeEvent, { alwaysForceDeleteWorktrees: true, editorWordWrap: false })
    ).rejects.toThrow('Disk full')
    expect(store.updateSettingsAndFlush).toHaveBeenCalledWith(
      { alwaysForceDeleteWorktrees: true, editorWordWrap: false },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('flushes the preserved-branch deletion preference before returning', async () => {
    store.getSettings.mockReturnValue({ alwaysForceDeletePreservedBranches: false })
    store.updateSettingsAndFlush.mockRejectedValue(new Error('Disk full'))
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1]
    if (typeof handler !== 'function') {
      throw new Error('Missing settings:set handler')
    }
    await expect(
      handler(settingsInvokeEvent, { alwaysForceDeletePreservedBranches: true })
    ).rejects.toThrow('Disk full')
    expect(store.updateSettingsAndFlush).toHaveBeenCalledWith(
      { alwaysForceDeletePreservedBranches: true },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('persists Active Server only through the dedicated preference channel', () => {
    store.updateSettings.mockReturnValue({ activeRuntimeEnvironmentId: 'windows-2' })
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:set-active-runtime-environment-preference'
    )?.[1] as (event: typeof settingsInvokeEvent, args: { environmentId: string | null }) => unknown

    expect(handler(settingsInvokeEvent, { environmentId: '  windows-2  ' })).toEqual({
      activeRuntimeEnvironmentId: 'windows-2'
    })
    expect(store.updateSettings).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'windows-2' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    handler(settingsInvokeEvent, { environmentId: 'Windows 2' })
    expect(store.updateSettings).toHaveBeenLastCalledWith(
      { activeRuntimeEnvironmentId: 'windows-2' },
      { notifyListeners: true, originWebContentsId: 1 }
    )

    expect(() => handler(settingsInvokeEvent, { environmentId: 42 as never })).toThrow(
      'Invalid default host for new projects'
    )
    expect(() => handler(settingsInvokeEvent, { environmentId: 'does-not-exist' })).toThrow(
      'Runtime environment not found'
    )
    expect(store.updateSettings).toHaveBeenCalledTimes(2)
  })

  it('does not accept floating workspace trust grants from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ floatingTerminalTrustedCwds: [] })
    store.updateSettings.mockReturnValue({ floatingTerminalTrustedCwds: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { floatingTerminalTrustedCwds: ['/tmp/notes'] })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {},
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('does not accept plugin authority grants from generic renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ pluginConsents: {}, disabledPlugins: [] })
    store.updateSettings.mockReturnValue({ pluginConsents: {}, disabledPlugins: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      pluginConsents: { 'samples.demo': 'sha256-forged' },
      disabledPlugins: ['samples.demo']
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {},
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes custom mobile pairing addresses before persistence', async () => {
    store.getSettings.mockReturnValue({
      mobilePairingCustomAddress: null,
      mobilePairingCustomAddresses: []
    })
    store.updateSettings.mockReturnValue({
      mobilePairingCustomAddress: '100.126.117.25:6768',
      mobilePairingCustomAddresses: ['first.example:6768']
    })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      mobilePairingCustomAddress: ' 100.126.117.25:6768 ',
      mobilePairingCustomAddresses: [' first.example:6768 ', 'host:99999', 'first.example:6768']
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        mobilePairingCustomAddress: '100.126.117.25:6768',
        mobilePairingCustomAddresses: ['first.example:6768']
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('clears malformed custom mobile pairing addresses before persistence', async () => {
    store.getSettings.mockReturnValue({ mobilePairingCustomAddress: '100.126.117.25:6768' })
    store.updateSettings.mockReturnValue({ mobilePairingCustomAddress: null })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { mobilePairingCustomAddress: 'host:99999' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { mobilePairingCustomAddress: null },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('drops invalid proxy URLs at the settings boundary', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: 'http://proxy.example:8080' })
    store.updateSettings.mockReturnValue({ httpProxyUrl: '' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { httpProxyUrl: 'ftp://proxy.example:2121' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { httpProxyUrl: '' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({ httpProxyUrl: '' })
  })
})
