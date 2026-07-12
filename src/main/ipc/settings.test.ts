import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyAppIconMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  rebuildAppMenuMock
} = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  prepareLocalWorktreeRootsForReposMock: vi.fn(),
  rebuildAppMenuMock: vi.fn()
}))

vi.mock('electron', () => ({
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

vi.mock('../app-icon', () => ({
  applyAppIcon: applyAppIconMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: prepareLocalWorktreeRootsForReposMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

import { registerSettingsHandlers } from './settings'

const settingsInvokeEvent = { sender: { id: 1 } }
type SettingsChangedListener = (
  updates: unknown,
  settings: unknown,
  originWebContentsId?: number
) => void

const store = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear()
    applyAppIconMock.mockClear()
    applyElectronProxySettingsMock.mockClear()
    applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
    previewGhosttyImportMock.mockClear()
    previewWarpThemeImportMock.mockClear()
    prepareLocalWorktreeRootsForReposMock.mockReset().mockResolvedValue(undefined)
    rebuildAppMenuMock.mockClear()
    browserWindowGetAllWindowsMock.mockReset()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.onSettingsChanged.mockClear()
  })

  it('registers settings:previewGhosttyImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewGhosttyImport')
  })

  it('answers the synchronous settings read with the persisted settings', () => {
    // Why: panes can bind PTYs before async hydration; the side-effect
    // authority kill switch needs the persisted value synchronously.
    store.getSettings.mockReturnValue({ terminalMainSideEffectAuthority: false })
    registerSettingsHandlers(store as never)

    const listener = onMock.mock.calls.find(
      (call) => call[0] === 'settings:get-sync'
    )?.[1] as (event: { returnValue: unknown }) => void
    expect(listener).toBeTypeOf('function')

    const event = { returnValue: undefined as unknown }
    listener(event)
    expect(event.returnValue).toEqual({ terminalMainSideEffectAuthority: false })
  })

  it('registers settings:previewWarpThemeImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewWarpThemeImport')
  })

  it('settings:previewGhosttyImport returns preview result', async () => {
    const expected = { found: false, diff: {}, unsupportedKeys: [] }
    previewGhosttyImportMock.mockResolvedValue(expected)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewGhosttyImport'
    )?.[1] as (_event: unknown, args: unknown) => Promise<unknown>

    const result = await handler!(null, {})
    expect(result).toEqual(expected)
    expect(previewGhosttyImportMock).toHaveBeenCalledWith(store)
  })

  it('settings:previewWarpThemeImport returns preview result', async () => {
    const expected = { found: false, themes: [], skippedFiles: [] }
    previewWarpThemeImportMock.mockResolvedValue(expected)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewWarpThemeImport'
    )?.[1] as (event: { sender: unknown }, args: { kind: 'auto' }) => Promise<unknown>

    const sender = { id: 3 }
    const result = await handler!({ sender }, { kind: 'auto' })
    expect(result).toEqual(expected)
    expect(previewWarpThemeImportMock).toHaveBeenCalledWith(store, { kind: 'auto' }, sender)
  })

  it('settings:previewWarpThemeImport forwards malformed sources for main validation', async () => {
    const expected = {
      found: false,
      themes: [],
      skippedFiles: [],
      error: 'Invalid Warp theme import source.'
    }
    previewWarpThemeImportMock.mockResolvedValue(expected)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewWarpThemeImport'
    )?.[1] as (event: { sender: unknown }, args: unknown) => Promise<unknown>

    const invalidSource = { kind: 'unknown' }
    const sender = { id: 3 }
    const result = await handler!({ sender }, invalidSource)
    expect(result).toEqual(expected)
    expect(previewWarpThemeImportMock).toHaveBeenCalledWith(store, invalidSource, sender)

    await handler!({ sender }, null)
    expect(previewWarpThemeImportMock).toHaveBeenCalledWith(store, null, sender)
  })

  it('broadcasts store-level settings changes to open windows', () => {
    const send = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: vi.fn() } }
    ])
    registerSettingsHandlers(store as never)

    const onSettingsChanged = store.onSettingsChanged as unknown as {
      mock: { calls: [SettingsChangedListener][] }
    }
    const listener = onSettingsChanged.mock.calls[0]?.[0]
    if (!listener) {
      throw new Error('settings change listener was not registered')
    }
    listener({ defaultTuiAgent: 'codex' }, { defaultTuiAgent: 'codex' })

    expect(send).toHaveBeenCalledWith('settings:changed', { defaultTuiAgent: 'codex' })
  })

  it('does not rebroadcast renderer settings writes to the origin window', () => {
    const originSend = vi.fn()
    const otherSend = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { id: 1, send: originSend } },
      { isDestroyed: () => false, webContents: { id: 2, send: otherSend } }
    ])
    registerSettingsHandlers(store as never)

    const onSettingsChanged = store.onSettingsChanged as unknown as {
      mock: { calls: [SettingsChangedListener][] }
    }
    const listener = onSettingsChanged.mock.calls[0]?.[0]
    if (!listener) {
      throw new Error('settings change listener was not registered')
    }
    listener({ defaultTuiAgent: 'codex' }, { defaultTuiAgent: 'codex' }, 1)

    expect(originSend).not.toHaveBeenCalled()
    expect(otherSend).toHaveBeenCalledWith('settings:changed', { defaultTuiAgent: 'codex' })
  })

  it('updates the agent awake service when the keep-awake setting changes', () => {
    const agentAwakeService = { setEnabled: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: true })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { keepComputerAwakeWhileAgentsRun: true })

    expect(agentAwakeService.setEnabled).toHaveBeenCalledWith(true)
  })

  it('does not notify the agent awake service for unrelated setting changes', () => {
    const agentAwakeService = { setEnabled: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { defaultTuiAgent: 'codex' })

    expect(agentAwakeService.setEnabled).not.toHaveBeenCalled()
  })

  it('prepares local worktree roots when workspace directory changes', async () => {
    store.getSettings.mockReturnValue({ workspaceDir: '/old/workspaces', nestWorkspaces: false })
    store.updateSettings.mockReturnValue({ workspaceDir: '/new/workspaces', nestWorkspaces: false })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { workspaceDir: '/new/workspaces' })

    expect(prepareLocalWorktreeRootsForReposMock).toHaveBeenCalledWith(store)
  })

  it('prepares local worktree roots when workspace nesting changes', async () => {
    store.getSettings.mockReturnValue({ workspaceDir: '/workspaces', nestWorkspaces: false })
    store.updateSettings.mockReturnValue({ workspaceDir: '/workspaces', nestWorkspaces: true })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { nestWorkspaces: true })

    expect(prepareLocalWorktreeRootsForReposMock).toHaveBeenCalledWith(store)
  })

  it('does not prepare local worktree roots when workspace layout values do not change', async () => {
    store.getSettings.mockReturnValue({ workspaceDir: '/workspaces', nestWorkspaces: false })
    store.updateSettings.mockReturnValue({ workspaceDir: '/workspaces', nestWorkspaces: false })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { workspaceDir: '/workspaces', nestWorkspaces: false })

    expect(prepareLocalWorktreeRootsForReposMock).not.toHaveBeenCalled()
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

  it('normalizes terminal scrollback row updates and drops legacy byte updates', async () => {
    store.getSettings.mockReturnValue({ terminalScrollbackRows: 5_000 })
    store.updateSettings.mockReturnValue({ terminalScrollbackRows: 50_000 })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      terminalScrollbackRows: 75_000,
      terminalScrollbackBytes: 250_000_000
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { terminalScrollbackRows: 50_000 },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes terminal line height updates before persistence', async () => {
    store.getSettings.mockReturnValue({ terminalLineHeight: 1 })
    store.updateSettings.mockReturnValue({ terminalLineHeight: 1 })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { terminalLineHeight: 0.85 })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { terminalLineHeight: 1 },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes custom terminal themes from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ terminalCustomThemes: [] })
    store.updateSettings.mockReturnValue({ terminalCustomThemes: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      terminalCustomThemes: [
        {
          id: 'warp:Test Theme',
          name: 'Test Theme',
          source: 'warp',
          mode: 'dark',
          terminal: {
            background: '000',
            foreground: 'fff',
            black: '123',
            red: 'nope'
          },
          sourcePath: '/Users/alice/.warp/themes/test.yaml'
        }
      ]
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        terminalCustomThemes: [
          expect.objectContaining({
            id: 'warp:test-theme',
            terminal: {
              background: '#000000',
              foreground: '#ffffff',
              black: '#112233'
            }
          })
        ]
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('sanitizes and applies proxy settings from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: '' })
    store.updateSettings.mockReturnValue({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      httpProxyUrl: ' http://proxy.example:8080/path#frag ',
      httpProxyBypassRules: 'localhost, *.internal'
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost;*.internal'
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
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

  it('normalizes and applies app icon changes from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ appIcon: 'classic' })
    store.updateSettings.mockReturnValue({ appIcon: 'watercolor' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { appIcon: 'watercolor' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { appIcon: 'watercolor' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyAppIconMock).toHaveBeenCalledWith('watercolor')
  })

  it('falls back to the classic app icon for invalid renderer settings IPC values', async () => {
    store.getSettings.mockReturnValue({ appIcon: 'watercolor' })
    store.updateSettings.mockReturnValue({ appIcon: 'classic' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { appIcon: 'not-real' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { appIcon: 'classic' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyAppIconMock).toHaveBeenCalledWith('classic')
  })

  it('rebuilds the app menu after Automations sidebar visibility changes', async () => {
    store.getSettings.mockReturnValue({ showAutomationsButton: true })
    store.updateSettings.mockReturnValue({ showAutomationsButton: false })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { showAutomationsButton: false })

    expect(rebuildAppMenuMock).toHaveBeenCalledTimes(1)
  })
})
