import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  attachMainWindowServicesMock,
  initTccPromptNoticeMock,
  preserveAgentAuthBeforeRestartMock,
  registerCoreHandlersMock,
  state,
  store
} = vi.hoisted(() => {
  const store = {
    writeLatestProfileStateJsonCompatibilityExport: vi.fn(),
    writeLatestProfileStateJsonExport: vi.fn(),
    getSettings: vi.fn(() => ({}))
  }
  return {
    attachMainWindowServicesMock: vi.fn(),
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
      rateLimits: { attach: vi.fn(), start: vi.fn() },
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
vi.mock('../macos-tcc-prompt-notice', () => ({ initTccPromptNotice: initTccPromptNoticeMock }))
vi.mock('../updater', () => ({ resolveUpdateInstallMode: vi.fn(() => 'interactive') }))
vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('../agent-auth-restart-preservation', () => ({
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

describe('main window profile-state update preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes rollback and compatibility exports before an update quit', async () => {
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

    await options.onBeforeUpdateQuit()

    expect(preserveAgentAuthBeforeRestartMock).toHaveBeenCalledWith({
      codexRuntimeHome: state.codexRuntimeHome,
      claudeRuntimeAuth: state.claudeRuntimeAuth,
      store
    })
    expect(store.writeLatestProfileStateJsonExport).toHaveBeenCalledOnce()
    expect(store.writeLatestProfileStateJsonCompatibilityExport).toHaveBeenCalledOnce()
    expect(options).toHaveProperty('onBeforeUpdateQuitFailure', 'abort')
    expect(store.writeLatestProfileStateJsonExport.mock.invocationCallOrder[0]).toBeLessThan(
      store.writeLatestProfileStateJsonCompatibilityExport.mock.invocationCallOrder[0]
    )
  })
})
