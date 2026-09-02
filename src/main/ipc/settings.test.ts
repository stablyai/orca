import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  listProfilesMock
} = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  prepareLocalWorktreeRootsForReposMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  applyBrowserSessionProxiesMock: vi.fn(),
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

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: prepareLocalWorktreeRootsForReposMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock
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
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
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
    listProfilesMock.mockReset().mockReturnValue([])
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

  it('does not reconcile hooks when the disabled-agent set is unchanged', async () => {
    const before = {
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    store.getSettings.mockReturnValue(before)
    store.updateSettings.mockReturnValue({
      ...before,
      disabledTuiAgents: ['claude', 'codex']
    })
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { disabledTuiAgents: string[] }
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { disabledTuiAgents: ['claude', 'codex'] })

    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
  })

  it('reconciles hooks when the disabled-agent set changes', async () => {
    const before = {
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updated = {
      ...before,
      disabledTuiAgents: ['claude']
    }
    store.getSettings.mockReturnValue(before)
    store.updateSettings.mockReturnValue(updated)
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { disabledTuiAgents: string[] }
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { disabledTuiAgents: ['claude'] })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledWith(
      true,
      updated,
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
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
      'Invalid Active Server preference'
    )
    expect(() => handler(settingsInvokeEvent, { environmentId: 'does-not-exist' })).toThrow(
      'Runtime environment not found'
    )
    expect(store.updateSettings).toHaveBeenCalledTimes(2)
  })

  it('applies bot-author deltas against the authoritative settings snapshot', () => {
    store.getSettings
      .mockReturnValueOnce({ prBotAuthorOverrides: ['alice'] })
      .mockReturnValueOnce({ prBotAuthorOverrides: ['alice', 'bob'] })
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:update-pr-bot-author-override'
    )?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { author: string; isBot: boolean }
    ) => unknown

    const result = handler(settingsInvokeEvent, { author: ' Bob ', isBot: true })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { prBotAuthorOverrides: ['alice', 'bob'] },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(result).toEqual({ prBotAuthorOverrides: ['alice', 'bob'] })
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
    const agentAwakeService = { setMode: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: true })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { keepComputerAwakeWhileAgentsRun: true })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        computerAwakeMode: 'auto',
        keepComputerAwakeWhileAgentsRun: true
      },
      expect.any(Object)
    )
    expect(agentAwakeService.setMode).toHaveBeenCalledWith('auto')
  })

  it('does not notify the agent awake service for unrelated setting changes', () => {
    const agentAwakeService = { setMode: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { defaultTuiAgent: 'codex' })

    expect(agentAwakeService.setMode).not.toHaveBeenCalled()
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

  it('does not accept plugin authority grants from generic renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ pluginConsents: {}, disabledPlugins: [] })
    store.updateSettings.mockReturnValue({ pluginConsents: {}, disabledPlugins: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      pluginConsents: { 'orca-samples.demo': 'sha256-forged' },
      disabledPlugins: ['orca-samples.demo']
    })

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

  it('does not sweep sessions for a no-op proxy save', async () => {
    const settings = {
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost'
    }
    store.getSettings.mockReturnValue(settings)
    store.updateSettings.mockReturnValue(settings)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl: string }
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { httpProxyUrl: 'http://proxy.example:8080' })

    expect(applyElectronProxySettingsMock).not.toHaveBeenCalled()
    expect(listProfilesMock).not.toHaveBeenCalled()
    expect(applyBrowserSessionProxiesMock).not.toHaveBeenCalled()
  })

  it('queues every proxy snapshot on both authorities before either apply settles', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: '', httpProxyBypassRules: '' })
    store.updateSettings.mockImplementation((args) =>
      args.httpProxyUrl !== undefined
        ? { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }
        : { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: 'late.example' }
    )
    let releaseFirstApply = (): void => {}
    let markFirstApplyStarted = (): void => {}
    const firstApplyStarted = new Promise<void>((resolve) => (markFirstApplyStarted = resolve))
    applyElectronProxySettingsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstApply = () => resolve({ source: 'settings' })
          markFirstApplyStarted()
        })
    )
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl?: string; httpProxyBypassRules?: string }
    ) => Promise<unknown>

    const first = handler(settingsInvokeEvent, { httpProxyUrl: 'socks5://127.0.0.1:1080' })
    await firstApplyStarted
    expect(applyBrowserSessionProxiesMock).toHaveBeenCalledWith([], {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })
    const second = handler(settingsInvokeEvent, { httpProxyBypassRules: 'late.example' })
    await second
    releaseFirstApply()
    await first

    expect(applyBrowserSessionProxiesMock.mock.calls.map((call) => call[1])).toEqual([
      {
        httpProxyUrl: 'socks5://127.0.0.1:1080',
        httpProxyBypassRules: ''
      },
      {
        httpProxyUrl: 'socks5://127.0.0.1:1080',
        httpProxyBypassRules: 'late.example'
      }
    ])
  })

  it('orders proxy writes before unrelated settings reconciliation can suspend', async () => {
    store.getSettings.mockReturnValue({
      httpProxyUrl: '',
      httpProxyBypassRules: '',
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
    store.updateSettings.mockImplementation((args) => ({
      httpProxyUrl: args.httpProxyUrl,
      httpProxyBypassRules: '',
      agentStatusHooksEnabled: args.agentStatusHooksEnabled ?? true,
      disabledTuiAgents: []
    }))
    let releaseHookReconciliation = (): void => {}
    let markHookReconciliationStarted = (): void => {}
    const hookReconciliationStarted = new Promise<void>(
      (resolve) => (markHookReconciliationStarted = resolve)
    )
    applyAgentStatusHooksEnabledMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHookReconciliation = () => resolve([])
          markHookReconciliationStarted()
        })
    )
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl: string; agentStatusHooksEnabled?: boolean }
    ) => Promise<unknown>

    const first = handler(settingsInvokeEvent, {
      httpProxyUrl: 'http://old.example:8080',
      agentStatusHooksEnabled: true
    })
    await hookReconciliationStarted
    await handler(settingsInvokeEvent, { httpProxyUrl: 'http://new.example:8080' })
    releaseHookReconciliation()
    await first

    expect(applyElectronProxySettingsMock.mock.calls.map((call) => call[0].httpProxyUrl)).toEqual([
      'http://old.example:8080',
      'http://new.example:8080'
    ])
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
