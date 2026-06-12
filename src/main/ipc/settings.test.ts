import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const {
  applyAppIconMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  browserWindowFromWebContentsMock,
  dialogShowOpenDialogMock,
  dialogShowSaveDialogMock,
  handleMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  readFileMock,
  rebuildAppMenuMock,
  writeFileMock
} = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  dialogShowSaveDialogMock: vi.fn(),
  handleMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  readFileMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  writeFileMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock,
    getAllWindows: browserWindowGetAllWindowsMock
  },
  dialog: {
    showOpenDialog: dialogShowOpenDialogMock,
    showSaveDialog: dialogShowSaveDialogMock
  },
  ipcMain: { handle: handleMock },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock
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

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

import { registerSettingsHandlers } from './settings'
import { getDefaultSettings } from '../../shared/constants'
import { createSettingsExportDocument } from '../../shared/settings-portability'

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
    applyAppIconMock.mockClear()
    applyElectronProxySettingsMock.mockClear()
    applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
    previewGhosttyImportMock.mockClear()
    previewWarpThemeImportMock.mockClear()
    rebuildAppMenuMock.mockClear()
    browserWindowGetAllWindowsMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    dialogShowOpenDialogMock.mockReset()
    dialogShowSaveDialogMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.onSettingsChanged.mockClear()
  })

  it('registers settings:previewGhosttyImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewGhosttyImport')
  })

  it('registers settings:previewWarpThemeImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewWarpThemeImport')
  })

  it('exports portable settings and keybindings to a JSON file', async () => {
    const keybindings = {
      getSnapshot: vi.fn(() => ({
        commonOverrides: { 'app.settings': ['Ctrl+,'] },
        platformOverrides: { darwin: { 'app.settings': ['Cmd+,'] } }
      }))
    }
    const settings = {
      ...getDefaultSettings(join('Users', 'test')),
      theme: 'dark' as const,
      workspaceDir: join('Users', 'test', 'private-workspaces')
    }
    store.getSettings.mockReturnValue(settings)
    const exportPath = join('tmp', 'orca.json')
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: false, filePath: exportPath })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:exportPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    const result = await handler(settingsInvokeEvent)

    expect(result).toMatchObject({ success: true, filePath: exportPath })
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const exported = JSON.parse(writeFileMock.mock.calls[0][1])
    expect(exported.settings.theme).toBe('dark')
    expect(exported.settings.workspaceDir).toBeUndefined()
    expect(exported.keybindings).toEqual({
      keybindings: { 'app.settings': ['Ctrl+,'] },
      platforms: { darwin: { 'app.settings': ['Cmd+,'] } }
    })
  })

  it('previews a freshly exported settings file as no changes', async () => {
    const userPath = join('Users', 'test')
    const settings = {
      ...getDefaultSettings(userPath),
      claudeAgentTeamsMode: 'orca-managed-tmux' as const,
      terminalQuickCommands: [
        {
          id: 'global-command',
          label: 'Global command',
          scope: { type: 'global' as const },
          action: 'terminal-command' as const,
          command: 'ls',
          appendEnter: true
        },
        {
          id: 'repo-command',
          label: 'Repo command',
          scope: { type: 'repo' as const, repoId: 'local-repo-id' },
          action: 'terminal-command' as const,
          command: 'npm test',
          appendEnter: true
        }
      ],
      sourceControlAi: {
        ...getDefaultSettings(userPath).sourceControlAi!,
        enabled: true,
        agentId: 'claude' as const,
        selectedModelByAgent: { claude: 'claude-opus-4-7' },
        selectedThinkingByModel: { 'claude-opus-4-7': 'low' }
      },
      voice: {
        ...getDefaultSettings(userPath).voice!,
        enabled: true,
        sttModel: 'zipformer-bilingual-zh-en',
        modelsDir: join(userPath, 'models'),
        userModels: [
          { id: 'custom-model', type: 'whisper' as const, dir: join(userPath, 'model') }
        ],
        openAiApiKeyConfigured: true
      }
    }
    const keybindingSnapshot = {
      commonOverrides: { 'terminal.search': ['Ctrl+Shift+F'] },
      platformOverrides: { darwin: {}, linux: {}, win32: {} }
    }
    const keybindings = {
      getSnapshot: vi.fn(() => keybindingSnapshot)
    }
    const exportPath = join('tmp', 'orca.json')
    store.getSettings.mockReturnValue(settings)
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: false, filePath: exportPath })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const exportHandler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:exportPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    await exportHandler(settingsInvokeEvent)
    const exportedJson = writeFileMock.mock.calls[0][1]

    dialogShowOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [exportPath] })
    readFileMock.mockResolvedValue(exportedJson)
    const previewHandler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewPortableImport'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    expect(await previewHandler(settingsInvokeEvent)).toMatchObject({
      ok: true,
      filePath: exportPath,
      changedSettingKeys: [],
      skippedSettingKeys: [],
      includesKeybindings: true,
      changedKeybindings: false
    })
  })

  it('previews a portable import with changed and skipped keys plus the picked path', async () => {
    const importPath = join('tmp', 'orca.json')
    const userPath = join('Users', 'test')
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [importPath] })
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...createSettingsExportDocument(getDefaultSettings(userPath)),
        settings: {
          theme: 'dark',
          workspaceDir: join(userPath, 'should-not-import')
        },
        keybindings: { keybindings: {}, platforms: {} }
      })
    )
    store.getSettings.mockReturnValue({ theme: 'system' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewPortableImport'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    expect(await handler(settingsInvokeEvent)).toMatchObject({
      ok: true,
      filePath: importPath,
      portableSettingCount: 1,
      changedSettingKeys: ['theme'],
      skippedSettingKeys: ['workspaceDir'],
      includesKeybindings: true,
      changedKeybindings: true
    })
  })

  it('reports a cancelled preview when the open dialog is dismissed', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewPortableImport'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    expect(await handler(settingsInvokeEvent)).toMatchObject({ ok: false, cancelled: true })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('imports only portable settings and keybindings from a JSON file', async () => {
    const keybindings = {
      replacePortableOverrides: vi.fn(() => ({ overrides: {} })),
      validatePortableOverrides: vi.fn()
    }
    const send = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } }
    ])
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...createSettingsExportDocument(getDefaultSettings(join('Users', 'test')), {
          keybindings: { keybindings: { 'app.settings': ['Ctrl+,'] }, platforms: {} }
        }),
        settings: {
          theme: 'dark',
          workspaceDir: join('Users', 'test', 'should-not-import')
        }
      })
    )
    store.getSettings.mockReturnValue({ theme: 'system' })
    store.updateSettings.mockReturnValue({ theme: 'dark' })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:importPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent, filePath: string) => Promise<unknown>

    const result = await handler(settingsInvokeEvent, join('tmp', 'orca.json'))

    expect(result).toMatchObject({
      success: true,
      portableSettingCount: 1,
      skippedSettingKeys: ['workspaceDir'],
      includesKeybindings: true
    })
    expect(store.updateSettings).toHaveBeenCalledWith(
      { theme: 'dark' },
      { notifyListeners: true, originWebContentsId: undefined }
    )
    expect(keybindings.replacePortableOverrides).toHaveBeenCalledWith({
      keybindings: { 'app.settings': ['Ctrl+,'] },
      platforms: {}
    })
    expect(send).toHaveBeenCalledWith('keybindings:changed', { overrides: {} })
  })

  it('does not apply settings when portable keybinding validation fails', async () => {
    const keybindings = {
      replacePortableOverrides: vi.fn(),
      validatePortableOverrides: vi.fn(() => {
        throw new Error('Bad shortcut')
      })
    }
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...createSettingsExportDocument(getDefaultSettings(join('Users', 'test')), {
          keybindings: { keybindings: { 'app.settings': ['not-a-shortcut'] }, platforms: {} }
        }),
        settings: { theme: 'dark' }
      })
    )
    store.getSettings.mockReturnValue({ theme: 'system' })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:importPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent, filePath: string) => Promise<unknown>

    await expect(handler(settingsInvokeEvent, join('tmp', 'orca.json'))).resolves.toMatchObject({
      success: false,
      error: 'Bad shortcut'
    })
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(keybindings.replacePortableOverrides).not.toHaveBeenCalled()
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
