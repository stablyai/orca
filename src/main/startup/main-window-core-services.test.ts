import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  attachMainWindowServicesMock,
  holdLaunchReconnectOptOutsMock,
  initTccPromptNoticeMock,
  preserveAgentAuthBeforeRestartMock,
  registerCoreHandlersMock,
  state,
  store
} = vi.hoisted(() => {
  const store = {
    flushPendingOrThrowAsync: vi.fn(async () => {}),
    writeLatestProfileStateJsonExportAsync: vi.fn(async () => {}),
    getSettings: vi.fn(() => ({})),
    onSettingsChanged: vi.fn((_listener: (updates: object) => void) => () => {}),
    getSshTargets: vi.fn(() => [{ id: 'ssh-1', reconnectOnLaunch: false }])
  }
  return {
    attachMainWindowServicesMock: vi.fn(),
    holdLaunchReconnectOptOutsMock: vi.fn(),
    initTccPromptNoticeMock: vi.fn(),
    preserveAgentAuthBeforeRestartMock: vi.fn(() => Promise.resolve()),
    registerCoreHandlersMock: vi.fn(),
    state: {
      store,
      runtime: {},
      stats: {},
      claudeUsage: {},
      codexUsage: {},
      openCodeUsage: {},
      museUsage: {},
      codexAccounts: {},
      claudeAccounts: {},
      rateLimits: { attach: vi.fn(), start: vi.fn(), stop: vi.fn() },
      automations: { setWebContents: vi.fn(), start: vi.fn() },
      keybindings: {},
      codexRuntimeHome: {},
      claudeRuntimeAuth: { prepareForClaudeLaunch: vi.fn() },
      agentAwakeService: null,
      crashReports: null,
      pluginService: null,
      pluginMarketplaceService: null,
      pluginMarketplaceInstaller: null,
      desktopRelayService: null,
      isServeMode: false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal seeds a nullable slot, like the real state object.
      stopClaudeUsagePolling: null as (() => void) | null,
      localPtyStartupReady: Promise.resolve(),
      localPtyProviderStartupReady: Promise.resolve()
    },
    store
  }
})

vi.mock('../ipc/register-core-handlers/register-core-handlers', () => ({
  registerCoreHandlers: registerCoreHandlersMock
}))
vi.mock('../window/attach-main-window-services', () => ({
  attachMainWindowServices: attachMainWindowServicesMock
}))
vi.mock('../ipc/ssh/ssh-host-user-disconnect', () => ({
  holdLaunchReconnectOptOuts: holdLaunchReconnectOptOutsMock
}))
vi.mock('../macos-permissions/macos-tcc-prompt-notice', () => ({
  initTccPromptNotice: initTccPromptNoticeMock
}))
vi.mock('../updater/updater-service', () => ({
  resolveUpdateInstallMode: vi.fn(() => 'interactive')
}))
vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('../providers/accounts/agent-auth-restart-preservation', () => ({
  preserveAgentAuthBeforeRestart: preserveAgentAuthBeforeRestartMock
}))
vi.mock('../codex/codex-ai-vault-session-resume', () => ({
  prepareCodexAiVaultSessionResume: vi.fn()
}))
vi.mock('../codex/codex-session-source-home', () => ({
  resolveHostCodexSessionSourceHome: vi.fn()
}))
vi.mock('./main-process-pty-startup', () => ({
  emitPluginWorktreeLifecycle: vi.fn(),
  handleCodexHomePtySpawned: vi.fn(),
  handlePtyExit: vi.fn()
}))
vi.mock('./codex-launch-preparation', () => ({ prepareCodexRuntimeHomeForLaunch: vi.fn() }))
vi.mock('./codex-session-resume-launch', () => ({ prepareCodexSessionResumeForLaunch: vi.fn() }))
vi.mock('./main-window-lifecycle-flags', () => ({ isRecoveryReloadInFlight: vi.fn() }))

const { attachMainWindowCoreServices } = await import('./main-window-core-services')

describe('main window launch reconnect opt-outs', () => {
  it('holds opted-out SSH hosts before core handlers start server status probes', () => {
    vi.clearAllMocks()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked BrowserWindow only needs webContents for this composition-root wiring test.
    attachMainWindowCoreServices({ webContents: { id: 17 } } as never, {
      markExpectedRendererReload: vi.fn(),
      recordRendererReload: vi.fn()
    })

    expect(holdLaunchReconnectOptOutsMock).toHaveBeenCalledWith([
      { id: 'ssh-1', reconnectOnLaunch: false }
    ])
    expect(holdLaunchReconnectOptOutsMock.mock.invocationCallOrder[0]).toBeLessThan(
      registerCoreHandlersMock.mock.invocationCallOrder[0]
    )
  })
})

describe('main window profile-state update preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([false, true])(
    'flushes SQL after preserving auth before an update quit (failure: %s)',
    async (fails) => {
      const window = { webContents: { id: 17 } }

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked BrowserWindow only needs webContents for this composition-root wiring test.
      attachMainWindowCoreServices(window as never, {
        markExpectedRendererReload: vi.fn(),
        recordRendererReload: vi.fn()
      })

      const options = attachMainWindowServicesMock.mock.calls[0]?.[5]
      if (
        typeof options !== 'object' ||
        options === null ||
        !('onBeforeUpdateQuit' in options) ||
        typeof options.onBeforeUpdateQuit !== 'function'
      ) {
        throw new Error('Expected update quit cleanup to be wired')
      }

      const failure = new Error('SQL commit refused')
      if (fails) {
        store.flushPendingOrThrowAsync.mockRejectedValueOnce(failure)
        await expect(options.onBeforeUpdateQuit()).rejects.toBe(failure)
      } else {
        await options.onBeforeUpdateQuit()
      }

      expect(preserveAgentAuthBeforeRestartMock).toHaveBeenCalledWith({
        codexRuntimeHome: state.codexRuntimeHome,
        store
      })
      expect(store.writeLatestProfileStateJsonExportAsync).not.toHaveBeenCalled()
      expect(store.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
      expect(store.flushPendingOrThrowAsync).toHaveBeenCalledWith({ fullCheckpoint: true })
      expect(preserveAgentAuthBeforeRestartMock.mock.invocationCallOrder[0]).toBeLessThan(
        store.flushPendingOrThrowAsync.mock.invocationCallOrder[0]
      )
      expect(options).toHaveProperty('onBeforeUpdateQuitFailure', 'abort')
    }
  )
})

const usageOff = { claudeAutoSwitchEnabled: false }
const usageOn = { claudeAutoSwitchEnabled: true }

describe('serve usage polling', () => {
  const start = state.rateLimits.start
  let info: ReturnType<typeof vi.spyOn>

  function attach(onClosed?: (listener: () => void) => void): void {
    const window = {
      webContents: { id: 17 },
      on: (event: string, listener: () => void) => {
        if (event === 'closed') {
          onClosed?.(listener)
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked BrowserWindow only needs webContents and on for this composition-root wiring test.
    attachMainWindowCoreServices(window as never, {
      markExpectedRendererReload: vi.fn(),
      recordRendererReload: vi.fn()
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.isServeMode = false
    state.stopClaudeUsagePolling?.()
    state.stopClaudeUsagePolling = null
    store.getSettings.mockImplementation(() => usageOn)
    store.onSettingsChanged.mockImplementation(() => () => {})
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    state.stopClaudeUsagePolling?.()
    state.stopClaudeUsagePolling = null
    state.isServeMode = false
    info.mockRestore()
  })

  it('keeps the desktop focus gate when serve mode is off', () => {
    attach()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith({ fetchImmediately: false })
    expect(info).toHaveBeenCalledWith(
      '[claude-usage] polling switch: mode=desktop pollInactive=false pollWithoutWindow=false'
    )
  })

  it('starts inactive Claude polling from Electron serve when a usage feature is on', () => {
    state.isServeMode = true
    attach()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith({
      fetchImmediately: true,
      pollWithoutWindow: true,
      pollInactiveClaude: true
    })
    expect(info).toHaveBeenCalledWith(
      '[claude-usage] polling switch: mode=serve pollInactive=true pollWithoutWindow=true'
    )
  })

  it('does not replace a serve launch poll with the desktop focus gate', () => {
    state.isServeMode = true
    state.stopClaudeUsagePolling = vi.fn()
    attach()
    expect(start).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('does not poll when every usage feature is off, then starts when one turns on', () => {
    state.isServeMode = true
    store.getSettings.mockImplementation(() => usageOff)
    let listener: ((updates: object) => void) | undefined
    store.onSettingsChanged.mockImplementation((callback) => {
      listener = callback
      return () => {
        listener = undefined
      }
    })
    let closed: (() => void) | undefined
    attach((listenerOnClosed) => {
      closed = listenerOnClosed
    })
    expect(start).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(
      '[claude-usage] polling switch: mode=serve pollInactive=false pollWithoutWindow=false'
    )

    store.getSettings.mockImplementation(() => usageOn)
    listener?.({ claudeAutoSwitchEnabled: true })
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith({
      fetchImmediately: true,
      pollWithoutWindow: true,
      pollInactiveClaude: true
    })
    expect(info).toHaveBeenCalledWith(
      '[claude-usage] polling switch: mode=serve pollInactive=true pollWithoutWindow=true'
    )

    closed?.()
    listener?.({ claudeModelPolicy: { enabled: false } })
    expect(start).toHaveBeenCalledTimes(1)
  })
})
