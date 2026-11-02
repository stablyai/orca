import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getPathMock,
  listEnvironmentsMock,
  callRuntimeEnvironmentMock,
  registerCliHandlersMock,
  registerPreflightHandlersMock,
  registerUsageProviderHandlersMock,
  registerGitHubHandlersMock,
  registerFeedbackHandlersMock,
  registerStatsHandlersMock,
  registerMemoryHandlersMock,
  registerNotebookHandlersMock,
  registerNotificationHandlersMock,
  registerDeveloperPermissionHandlersMock,
  registerComputerUsePermissionHandlersMock,
  registerSettingsHandlersMock,
  registerKeybindingHandlersMock,
  registerTelemetryHandlersMock,
  registerDiagnosticsHandlersMock,
  registerTerminalRenderDesyncEvidenceHandlerMock,
  registerShellHandlersMock,
  registerPetHandlersMock,
  registerSessionHandlersMock,
  registerUIHandlersMock,
  setTrustedUIRendererWebContentsIdMock,
  registerFilesystemHandlersMock,
  registerRuntimeHandlersMock,
  registerRuntimeEnvironmentHandlersMock,
  registerEphemeralVmHandlersMock,
  registerAiVaultHandlersMock,
  registerAiVaultSearchHandlersMock,
  registerOrcaProfileHandlersMock,
  registerCodexAccountHandlersMock,
  registerAgentHookHandlersMock,
  registerClaudeAccountHandlersMock,
  registerOpenCodeGoCredentialsHandlersMock,
  registerMiniMaxCredentialsHandlersMock,
  registerZcodePlanCredentialsHandlersMock,
  registerGrokAccountHandlersMock,
  registerCursorAccountHandlersMock,
  registerClipboardHandlersMock,
  setTrustedClipboardRendererWebContentsIdMock,
  registerUpdaterHandlersMock,
  registerRateLimitHandlersMock,
  registerBrowserHandlersMock,
  setAgentBrowserBridgeRefMock,
  setTrustedBrowserRendererWebContentsIdMock,
  registerFilesystemWatcherHandlersMock,
  registerAppHandlersMock,
  registerLinearHandlersMock,
  registerJiraHandlersMock,
  registerJiraIssueSummaryGenerationHandlersMock,
  registerBitbucketHandlersMock,
  registerGitLabHandlersMock,
  registerHostedReviewHandlersMock,
  registerExportHandlersMock,
  registerCodexConfigSyncHandlersMock,
  registerOnboardingHandlersMock,
  registerDashboardPopoutHandlersMock,
  registerWorkspaceSpaceWindowHandlersMock,
  isDashboardPopoutRendererMock,
  registerTerminalPreviewHandlersMock,
  registerSpeechHandlersMock,
  registerSkillsHandlersMock,
  registerSkillDeleteIpcHandlersMock,
  registerWorkspaceSpaceHandlersMock,
  registerWorkspacePortHandlersMock,
  registerLocalhostWorktreeLabelHandlersMock,
  registerNativeChatHandlersMock,
  registerEmulatorFrameStreamHandlersMock,
  registerEmulatorVideoStreamHandlersMock,
  registerEmulatorScrcpyTouchHandlerMock
} = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/test/user-data'),
  listEnvironmentsMock: vi.fn(() => []),
  callRuntimeEnvironmentMock: vi.fn(),
  registerCliHandlersMock: vi.fn(),
  registerPreflightHandlersMock: vi.fn(),
  registerUsageProviderHandlersMock: vi.fn(),
  registerGitHubHandlersMock: vi.fn(),
  registerFeedbackHandlersMock: vi.fn(),
  registerStatsHandlersMock: vi.fn(),
  registerMemoryHandlersMock: vi.fn(),
  registerNotebookHandlersMock: vi.fn(),
  registerNotificationHandlersMock: vi.fn(),
  registerDeveloperPermissionHandlersMock: vi.fn(),
  registerComputerUsePermissionHandlersMock: vi.fn(),
  registerSettingsHandlersMock: vi.fn(),
  registerKeybindingHandlersMock: vi.fn(),
  registerTelemetryHandlersMock: vi.fn(),
  registerDiagnosticsHandlersMock: vi.fn(),
  registerTerminalRenderDesyncEvidenceHandlerMock: vi.fn(),
  registerShellHandlersMock: vi.fn(),
  registerPetHandlersMock: vi.fn(),
  registerSessionHandlersMock: vi.fn(),
  registerUIHandlersMock: vi.fn(),
  setTrustedUIRendererWebContentsIdMock: vi.fn(),
  registerFilesystemHandlersMock: vi.fn(),
  registerRuntimeHandlersMock: vi.fn(),
  registerRuntimeEnvironmentHandlersMock: vi.fn(),
  registerEphemeralVmHandlersMock: vi.fn(),
  registerAiVaultHandlersMock: vi.fn(),
  registerAiVaultSearchHandlersMock: vi.fn(),
  registerOrcaProfileHandlersMock: vi.fn(),
  registerCodexAccountHandlersMock: vi.fn(),
  registerAgentHookHandlersMock: vi.fn(),
  registerClaudeAccountHandlersMock: vi.fn(),
  registerOpenCodeGoCredentialsHandlersMock: vi.fn(),
  registerMiniMaxCredentialsHandlersMock: vi.fn(),
  registerZcodePlanCredentialsHandlersMock: vi.fn(),
  registerGrokAccountHandlersMock: vi.fn(),
  registerCursorAccountHandlersMock: vi.fn(),
  registerClipboardHandlersMock: vi.fn(),
  setTrustedClipboardRendererWebContentsIdMock: vi.fn(),
  registerUpdaterHandlersMock: vi.fn(),
  registerRateLimitHandlersMock: vi.fn(),
  registerBrowserHandlersMock: vi.fn(),
  setAgentBrowserBridgeRefMock: vi.fn(),
  setTrustedBrowserRendererWebContentsIdMock: vi.fn(),
  registerFilesystemWatcherHandlersMock: vi.fn(),
  registerAppHandlersMock: vi.fn(),
  registerLinearHandlersMock: vi.fn(),
  registerJiraHandlersMock: vi.fn(),
  registerJiraIssueSummaryGenerationHandlersMock: vi.fn(),
  registerBitbucketHandlersMock: vi.fn(),
  registerGitLabHandlersMock: vi.fn(),
  registerHostedReviewHandlersMock: vi.fn(),
  registerExportHandlersMock: vi.fn(),
  registerCodexConfigSyncHandlersMock: vi.fn(),
  registerOnboardingHandlersMock: vi.fn(),
  registerDashboardPopoutHandlersMock: vi.fn(),
  registerWorkspaceSpaceWindowHandlersMock: vi.fn(),
  isDashboardPopoutRendererMock: vi.fn(),
  registerTerminalPreviewHandlersMock: vi.fn(),
  registerSpeechHandlersMock: vi.fn(),
  registerSkillsHandlersMock: vi.fn(),
  registerSkillDeleteIpcHandlersMock: vi.fn(),
  registerWorkspaceSpaceHandlersMock: vi.fn(),
  registerWorkspacePortHandlersMock: vi.fn(),
  registerLocalhostWorktreeLabelHandlersMock: vi.fn(),
  registerNativeChatHandlersMock: vi.fn(),
  registerEmulatorFrameStreamHandlersMock: vi.fn(),
  registerEmulatorVideoStreamHandlersMock: vi.fn(),
  registerEmulatorScrcpyTouchHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock,
    once: vi.fn()
  },
  webContents: { fromId: () => undefined }
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('../runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

vi.mock('../codex-config-sync', () => ({
  registerCodexConfigSyncHandlers: registerCodexConfigSyncHandlersMock
}))

vi.mock('../onboarding', () => ({
  registerOnboardingHandlers: registerOnboardingHandlersMock
}))

vi.mock('../dashboard-popout', () => ({
  registerDashboardPopoutHandlers: registerDashboardPopoutHandlersMock
}))

vi.mock('../workspace-space-window', () => ({
  registerWorkspaceSpaceWindowHandlers: registerWorkspaceSpaceWindowHandlersMock
}))

vi.mock('../../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: isDashboardPopoutRendererMock
}))

vi.mock('../terminal-preview', () => ({
  registerTerminalPreviewHandlers: registerTerminalPreviewHandlersMock
}))

vi.mock('../speech', () => ({
  registerSpeechHandlers: registerSpeechHandlersMock
}))

vi.mock('../cli', () => ({
  registerCliHandlers: registerCliHandlersMock
}))

vi.mock('../preflight', () => ({
  registerPreflightHandlers: registerPreflightHandlersMock
}))

vi.mock('../usage-provider-handlers', () => ({
  registerUsageProviderHandlers: registerUsageProviderHandlersMock
}))

vi.mock('../github', () => ({
  registerGitHubHandlers: registerGitHubHandlersMock
}))

vi.mock('../feedback', () => ({
  registerFeedbackHandlers: registerFeedbackHandlersMock
}))

vi.mock('../export', () => ({
  registerExportHandlers: registerExportHandlersMock
}))

vi.mock('../stats', () => ({
  registerStatsHandlers: registerStatsHandlersMock
}))

vi.mock('../memory', () => ({
  registerMemoryHandlers: registerMemoryHandlersMock
}))

vi.mock('../notebook', () => ({
  registerNotebookHandlers: registerNotebookHandlersMock
}))

vi.mock('../notifications', () => ({
  registerNotificationHandlers: registerNotificationHandlersMock
}))

vi.mock('../developer-permissions', () => ({
  registerDeveloperPermissionHandlers: registerDeveloperPermissionHandlersMock
}))

vi.mock('../computer-use-permissions', () => ({
  registerComputerUsePermissionHandlers: registerComputerUsePermissionHandlersMock
}))

vi.mock('../settings', () => ({
  registerSettingsHandlers: registerSettingsHandlersMock
}))

vi.mock('../skills', () => ({
  registerSkillsHandlers: registerSkillsHandlersMock
}))

vi.mock('../skill-delete/handlers', () => ({
  registerSkillDeleteIpcHandlers: registerSkillDeleteIpcHandlersMock
}))

vi.mock('../workspace-space', () => ({
  registerWorkspaceSpaceHandlers: registerWorkspaceSpaceHandlersMock
}))

vi.mock('../workspace-ports', () => ({
  registerWorkspacePortHandlers: registerWorkspacePortHandlersMock
}))

vi.mock('../link-preview', () => ({ registerLinkPreviewHandlers: vi.fn() }))

vi.mock('../localhost-worktree-labels', () => ({
  registerLocalhostWorktreeLabelHandlers: registerLocalhostWorktreeLabelHandlersMock
}))

vi.mock('../keybindings', () => ({
  registerKeybindingHandlers: registerKeybindingHandlersMock
}))

vi.mock('../telemetry', () => ({
  registerTelemetryHandlers: registerTelemetryHandlersMock
}))

vi.mock('../diagnostics', () => ({
  registerDiagnosticsHandlers: registerDiagnosticsHandlersMock
}))

vi.mock('../shell', () => ({
  registerShellHandlers: registerShellHandlersMock
}))

vi.mock('../pet', () => ({
  registerPetHandlers: registerPetHandlersMock
}))

vi.mock('../session', () => ({
  registerSessionHandlers: registerSessionHandlersMock
}))

vi.mock('../ui', () => ({
  registerUIHandlers: registerUIHandlersMock,
  setTrustedUIRendererWebContentsId: setTrustedUIRendererWebContentsIdMock
}))

vi.mock('../emulator-frame-stream', () => ({
  registerEmulatorFrameStreamHandlers: registerEmulatorFrameStreamHandlersMock
}))

vi.mock('../emulator-video-stream', () => ({
  registerEmulatorVideoStreamHandlers: registerEmulatorVideoStreamHandlersMock
}))

vi.mock('../emulator-scrcpy-touch', () => ({
  registerEmulatorScrcpyTouchHandler: registerEmulatorScrcpyTouchHandlerMock
}))

vi.mock('../emulator-scrcpy-keyboard', () => ({
  registerEmulatorScrcpyKeyboardHandler: vi.fn()
}))

vi.mock('../filesystem/filesystem', () => ({
  registerFilesystemHandlers: registerFilesystemHandlersMock
}))

vi.mock('../filesystem/watchers/filesystem-watcher-handlers', () => ({
  registerFilesystemWatcherHandlers: registerFilesystemWatcherHandlersMock
}))

vi.mock('../rate-limits', () => ({
  registerRateLimitHandlers: registerRateLimitHandlersMock
}))

vi.mock('../runtime', () => ({
  registerRuntimeHandlers: registerRuntimeHandlersMock
}))

vi.mock('../runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(),
  registerRuntimeEnvironmentHandlers: registerRuntimeEnvironmentHandlersMock
}))

vi.mock('../wsl-host-handlers', () => ({
  registerWslHostHandlers: vi.fn()
}))

vi.mock('../wsl-move-handlers', () => ({
  registerWslMoveHandlers: vi.fn()
}))

vi.mock('../wsl-move-orchestrator-wiring', () => ({
  registerWslMoveOrchestrator: vi.fn()
}))

vi.mock('../wsl-drive-project-handlers', () => ({
  registerWslDriveProjectHandlers: vi.fn()
}))

vi.mock('../ephemeral-vm', () => ({
  registerEphemeralVmHandlers: registerEphemeralVmHandlersMock
}))

vi.mock('../ai-vault', () => ({
  registerAiVaultHandlers: registerAiVaultHandlersMock
}))

vi.mock('../ai-vault-search', () => ({
  registerAiVaultSearchHandlers: registerAiVaultSearchHandlersMock
}))

vi.mock('../orca-profiles', () => ({
  registerOrcaProfileHandlers: registerOrcaProfileHandlersMock
}))

vi.mock('../codex-accounts', () => ({
  registerCodexAccountHandlers: registerCodexAccountHandlersMock
}))

vi.mock('../agent-hooks', () => ({
  registerAgentHookHandlers: registerAgentHookHandlersMock
}))

vi.mock('../claude-accounts', () => ({
  registerClaudeAccountHandlers: registerClaudeAccountHandlersMock
}))

vi.mock('../opencode-go-credentials', () => ({
  registerOpenCodeGoCredentialsHandlers: registerOpenCodeGoCredentialsHandlersMock
}))

vi.mock('../minimax-credentials', () => ({
  registerMiniMaxCredentialsHandlers: registerMiniMaxCredentialsHandlersMock
}))

vi.mock('../zcode-plan-credentials', () => ({
  registerZcodePlanCredentialsHandlers: registerZcodePlanCredentialsHandlersMock
}))

vi.mock('../grok-accounts', () => ({
  registerGrokAccountHandlers: registerGrokAccountHandlersMock
}))

vi.mock('../cursor-accounts', () => ({
  registerCursorAccountHandlers: registerCursorAccountHandlersMock
}))

vi.mock('../../window/attach-main-window-services', () => ({
  registerUpdaterHandlers: registerUpdaterHandlersMock
}))

vi.mock('../../window/clipboard-ipc-handlers', () => ({
  registerClipboardHandlers: registerClipboardHandlersMock,
  setTrustedClipboardRendererWebContentsId: setTrustedClipboardRendererWebContentsIdMock
}))

vi.mock('../browser', () => ({
  registerBrowserHandlers: registerBrowserHandlersMock,
  setAgentBrowserBridgeRef: setAgentBrowserBridgeRefMock
}))

vi.mock('../browser-renderer-trust', () => ({
  setTrustedBrowserRendererWebContentsId: setTrustedBrowserRendererWebContentsIdMock
}))

vi.mock('../app', () => ({
  registerAppHandlers: registerAppHandlersMock
}))

vi.mock('../terminal-render-desync-evidence', () => ({
  registerTerminalRenderDesyncEvidenceHandler: registerTerminalRenderDesyncEvidenceHandlerMock
}))

vi.mock('../linear/register-handlers', () => ({
  registerLinearHandlers: registerLinearHandlersMock
}))

vi.mock('../jira/register-handlers', () => ({
  registerJiraHandlers: registerJiraHandlersMock
}))

vi.mock('../jira/issue-summary-generation', () => ({
  registerJiraIssueSummaryGenerationHandlers: registerJiraIssueSummaryGenerationHandlersMock
}))

vi.mock('../bitbucket', () => ({
  registerBitbucketHandlers: registerBitbucketHandlersMock
}))

vi.mock('../gitlab', () => ({
  registerGitLabHandlers: registerGitLabHandlersMock
}))

vi.mock('../hosted-review', () => ({
  registerHostedReviewHandlers: registerHostedReviewHandlersMock
}))

vi.mock('../native-chat', () => ({
  registerNativeChatHandlers: registerNativeChatHandlersMock
}))

import { agentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { recordStructuredAgentSessionHostInstallRefusal } from '../../runtime/agent-session/structured-agent-session-host-refusal'
import { registerCoreHandlers } from './register-core-handlers'

let registeredAiVaultOptions: {
  ensureStructuredSessionOwnership: () => Promise<void>
}
let registeredRuntime:
  | {
      ensureStructuredAgentSessionHost: ReturnType<typeof vi.fn>
      closeNotificationDismissals: ReturnType<typeof vi.fn>
    }
  | undefined
let registeredRelaunchExit: (() => Promise<void>) | undefined

describe('registerCoreHandlers', () => {
  beforeEach(() => {
    getPathMock.mockReset()
    getPathMock.mockReturnValue('/test/user-data')
    listEnvironmentsMock.mockReset()
    listEnvironmentsMock.mockReturnValue([])
    callRuntimeEnvironmentMock.mockReset()
    registerCliHandlersMock.mockReset()
    registerPreflightHandlersMock.mockReset()
    registerUsageProviderHandlersMock.mockReset()
    registerGitHubHandlersMock.mockReset()
    registerFeedbackHandlersMock.mockReset()
    registerStatsHandlersMock.mockReset()
    registerMemoryHandlersMock.mockReset()
    registerNotebookHandlersMock.mockReset()
    registerNotificationHandlersMock.mockReset()
    registerDeveloperPermissionHandlersMock.mockReset()
    registerComputerUsePermissionHandlersMock.mockReset()
    registerSettingsHandlersMock.mockReset()
    registerKeybindingHandlersMock.mockReset()
    registerTelemetryHandlersMock.mockReset()
    registerDiagnosticsHandlersMock.mockReset()
    registerTerminalRenderDesyncEvidenceHandlerMock.mockReset()
    registerShellHandlersMock.mockReset()
    registerPetHandlersMock.mockReset()
    registerSessionHandlersMock.mockReset()
    registerUIHandlersMock.mockReset()
    setTrustedUIRendererWebContentsIdMock.mockReset()
    registerFilesystemHandlersMock.mockReset()
    registerRuntimeHandlersMock.mockReset()
    registerRuntimeEnvironmentHandlersMock.mockReset()
    registerEphemeralVmHandlersMock.mockReset()
    registerAiVaultHandlersMock.mockReset()
    registerOrcaProfileHandlersMock.mockReset()
    registerCodexAccountHandlersMock.mockReset()
    registerAgentHookHandlersMock.mockReset()
    registerClaudeAccountHandlersMock.mockReset()
    registerOpenCodeGoCredentialsHandlersMock.mockReset()
    registerMiniMaxCredentialsHandlersMock.mockReset()
    registerZcodePlanCredentialsHandlersMock.mockReset()
    registerClipboardHandlersMock.mockReset()
    setTrustedClipboardRendererWebContentsIdMock.mockReset()
    registerUpdaterHandlersMock.mockReset()
    registerRateLimitHandlersMock.mockReset()
    registerBrowserHandlersMock.mockReset()
    setAgentBrowserBridgeRefMock.mockReset()
    setTrustedBrowserRendererWebContentsIdMock.mockReset()
    registerFilesystemWatcherHandlersMock.mockReset()
    registerAppHandlersMock.mockReset()
    registerLinearHandlersMock.mockReset()
    registerJiraHandlersMock.mockReset()
    registerJiraIssueSummaryGenerationHandlersMock.mockReset()
    registerBitbucketHandlersMock.mockReset()
    registerGitLabHandlersMock.mockReset()
    registerHostedReviewHandlersMock.mockReset()
    registerExportHandlersMock.mockReset()
    registerDashboardPopoutHandlersMock.mockReset()
    registerWorkspaceSpaceWindowHandlersMock.mockReset()
    registerTerminalPreviewHandlersMock.mockReset()
    registerSpeechHandlersMock.mockReset()
    registerSkillsHandlersMock.mockReset()
    registerSkillDeleteIpcHandlersMock.mockReset()
    registerWorkspaceSpaceHandlersMock.mockReset()
    registerWorkspacePortHandlersMock.mockReset()
    registerLocalhostWorktreeLabelHandlersMock.mockReset()
    registerNativeChatHandlersMock.mockReset()
    registerEmulatorFrameStreamHandlersMock.mockReset()
    registerEmulatorVideoStreamHandlersMock.mockReset()
    registerEmulatorScrcpyTouchHandlerMock.mockReset()
  })

  it('reports malformed runtime session lists as host diagnostics', async () => {
    const store = { marker: 'store' }
    const runtime = {
      marker: 'runtime',
      getAgentBrowserBridge: () => null,
      ensureStructuredAgentSessionHost: vi.fn(),
      closeNotificationDismissals: vi.fn(async () => {})
    }
    const stats = { marker: 'stats' }
    const claudeUsage = { marker: 'claudeUsage' }
    const codexUsage = { marker: 'codexUsage' }
    const openCodeUsage = { marker: 'openCodeUsage' }
    const museUsage = { marker: 'museUsage' }
    const codexAccounts = { marker: 'codexAccounts', runtimeHomeService: { marker: 'runtimeHome' } }
    const claudeAccounts = { marker: 'claudeAccounts' }
    const rateLimits = { marker: 'rateLimits' }
    const agentAwakeService = { marker: 'agentAwakeService' }
    const onBeforeRelaunch = vi.fn()
    const getAdditionalAiVaultCodexHomePaths = vi.fn(() => ['/runtime/codex/home'])

    registerCoreHandlers(
      store as never,
      runtime as never,
      stats as never,
      claudeUsage as never,
      codexUsage as never,
      openCodeUsage as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only forwards this marker to the mocked usage registrar.
      museUsage as never,
      codexAccounts as never,
      claudeAccounts as never,
      rateLimits as never,
      null,
      undefined,
      undefined,
      agentAwakeService as never,
      undefined,
      undefined,
      { getAdditionalAiVaultCodexHomePaths, onBeforeRelaunch }
    )

    const aiVaultOptions = registerAiVaultHandlersMock.mock.calls[0]?.[0]
    expect(aiVaultOptions).toBeDefined()
    // Registration happens once per module: later tests reach these handlers through here.
    registeredAiVaultOptions = aiVaultOptions
    registeredRuntime = runtime

    callRuntimeEnvironmentMock.mockResolvedValueOnce({
      ok: true,
      result: { sessions: 'bad-shape' }
    })

    registeredRelaunchExit = registerAppHandlersMock.mock.calls[0]?.[1]?.onBeforeRelaunchExit

    await expect(
      aiVaultOptions.scanRuntimeAiVaultSessions(
        'env-123',
        {
          limit: 10,
          scopePaths: ['/workspace']
        },
        { timeoutMs: 3000 }
      )
    ).resolves.toEqual({
      sessions: [],
      issues: [
        expect.objectContaining({
          executionHostId: 'runtime:env-123',
          agent: 'codex',
          path: 'env-123',
          message: expect.stringContaining('Invalid aiVault.listSessions response')
        })
      ],
      scannedAt: expect.any(String)
    })
  })

  // Chat refusal must not disable session history/resume; other ownership failures still propagate.
  it('serves session history while chats are refused', async () => {
    const aiVaultOptions = registeredAiVaultOptions
    expect(aiVaultOptions).toBeDefined()
    const refusal = agentSessionRefusalError(
      'agent_session_journal_unreadable',
      { reason: 'journalCorrupt' },
      'Unable to load this chat.'
    )
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    try {
      registeredRuntime?.ensureStructuredAgentSessionHost.mockRejectedValueOnce(refusal)
      await expect(aiVaultOptions.ensureStructuredSessionOwnership()).resolves.toBeUndefined()
      registeredRuntime?.ensureStructuredAgentSessionHost.mockRejectedValueOnce(
        new Error('the record store would not open')
      )
      await expect(aiVaultOptions.ensureStructuredSessionOwnership()).rejects.toThrow(
        'the record store would not open'
      )
    } finally {
      recordStructuredAgentSessionHostInstallRefusal(null)
    }
  })

  it('lets relaunch exit after 2 s when the dismissal close never settles', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registeredRuntime?.closeNotificationDismissals.mockReturnValueOnce(new Promise(() => {}))
      let exited = false
      void registeredRelaunchExit?.().then(() => {
        exited = true
      })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(exited).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(exited).toBe(true)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
