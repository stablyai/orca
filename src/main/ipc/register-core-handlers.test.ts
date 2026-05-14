/* eslint-disable max-lines -- Why: this test mirrors the complete core IPC handler registry so
   duplicate-registration coverage stays tied to the one production entry point. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  registerCliHandlersMock,
  registerPreflightHandlersMock,
  registerClaudeUsageHandlersMock,
  registerCodexUsageHandlersMock,
  registerGitHubHandlersMock,
  registerFeedbackHandlersMock,
  registerStatsHandlersMock,
  registerMemoryHandlersMock,
  registerNotebookHandlersMock,
  registerNotesHandlersMock,
  registerNotificationHandlersMock,
  registerDeveloperPermissionHandlersMock,
  registerComputerUsePermissionHandlersMock,
  registerSettingsHandlersMock,
  registerTelemetryHandlersMock,
  registerShellHandlersMock,
  registerPetHandlersMock,
  registerSessionHandlersMock,
  registerUIHandlersMock,
  registerFilesystemHandlersMock,
  registerRuntimeHandlersMock,
  registerCodexAccountHandlersMock,
  registerAgentHookHandlersMock,
  registerAgentTrustHandlersMock,
  registerClaudeAccountHandlersMock,
  registerClipboardHandlersMock,
  registerUpdaterHandlersMock,
  registerRateLimitHandlersMock,
  registerBrowserHandlersMock,
  setAgentBrowserBridgeRefMock,
  setTrustedBrowserRendererWebContentsIdMock,
  registerFilesystemWatcherHandlersMock,
  registerAppHandlersMock,
  registerLinearHandlersMock,
  registerExportHandlersMock,
  registerOnboardingHandlersMock,
  registerSpeechHandlersMock
} = vi.hoisted(() => ({
  registerCliHandlersMock: vi.fn(),
  registerPreflightHandlersMock: vi.fn(),
  registerClaudeUsageHandlersMock: vi.fn(),
  registerCodexUsageHandlersMock: vi.fn(),
  registerGitHubHandlersMock: vi.fn(),
  registerFeedbackHandlersMock: vi.fn(),
  registerStatsHandlersMock: vi.fn(),
  registerMemoryHandlersMock: vi.fn(),
  registerNotebookHandlersMock: vi.fn(),
  registerNotesHandlersMock: vi.fn(),
  registerNotificationHandlersMock: vi.fn(),
  registerDeveloperPermissionHandlersMock: vi.fn(),
  registerComputerUsePermissionHandlersMock: vi.fn(),
  registerSettingsHandlersMock: vi.fn(),
  registerTelemetryHandlersMock: vi.fn(),
  registerShellHandlersMock: vi.fn(),
  registerPetHandlersMock: vi.fn(),
  registerSessionHandlersMock: vi.fn(),
  registerUIHandlersMock: vi.fn(),
  registerFilesystemHandlersMock: vi.fn(),
  registerRuntimeHandlersMock: vi.fn(),
  registerCodexAccountHandlersMock: vi.fn(),
  registerAgentHookHandlersMock: vi.fn(),
  registerAgentTrustHandlersMock: vi.fn(),
  registerClaudeAccountHandlersMock: vi.fn(),
  registerClipboardHandlersMock: vi.fn(),
  registerUpdaterHandlersMock: vi.fn(),
  registerRateLimitHandlersMock: vi.fn(),
  registerBrowserHandlersMock: vi.fn(),
  setAgentBrowserBridgeRefMock: vi.fn(),
  setTrustedBrowserRendererWebContentsIdMock: vi.fn(),
  registerFilesystemWatcherHandlersMock: vi.fn(),
  registerAppHandlersMock: vi.fn(),
  registerLinearHandlersMock: vi.fn(),
  registerExportHandlersMock: vi.fn(),
  registerOnboardingHandlersMock: vi.fn(),
  registerSpeechHandlersMock: vi.fn()
}))

vi.mock('./onboarding', () => ({
  registerOnboardingHandlers: registerOnboardingHandlersMock
}))

vi.mock('./speech', () => ({
  registerSpeechHandlers: registerSpeechHandlersMock
}))

vi.mock('./cli', () => ({
  registerCliHandlers: registerCliHandlersMock
}))

vi.mock('./preflight', () => ({
  registerPreflightHandlers: registerPreflightHandlersMock
}))

vi.mock('./claude-usage', () => ({
  registerClaudeUsageHandlers: registerClaudeUsageHandlersMock
}))

vi.mock('./codex-usage', () => ({
  registerCodexUsageHandlers: registerCodexUsageHandlersMock
}))

vi.mock('./github', () => ({
  registerGitHubHandlers: registerGitHubHandlersMock
}))

vi.mock('./feedback', () => ({
  registerFeedbackHandlers: registerFeedbackHandlersMock
}))

vi.mock('./export', () => ({
  registerExportHandlers: registerExportHandlersMock
}))

vi.mock('./stats', () => ({
  registerStatsHandlers: registerStatsHandlersMock
}))

vi.mock('./memory', () => ({
  registerMemoryHandlers: registerMemoryHandlersMock
}))

vi.mock('./notebook', () => ({
  registerNotebookHandlers: registerNotebookHandlersMock
}))

vi.mock('./notes', () => ({
  registerNotesHandlers: registerNotesHandlersMock
}))

vi.mock('./notifications', () => ({
  registerNotificationHandlers: registerNotificationHandlersMock
}))

vi.mock('./developer-permissions', () => ({
  registerDeveloperPermissionHandlers: registerDeveloperPermissionHandlersMock
}))

vi.mock('./computer-use-permissions', () => ({
  registerComputerUsePermissionHandlers: registerComputerUsePermissionHandlersMock
}))

vi.mock('./settings', () => ({
  registerSettingsHandlers: registerSettingsHandlersMock
}))

vi.mock('./telemetry', () => ({
  registerTelemetryHandlers: registerTelemetryHandlersMock
}))

vi.mock('./shell', () => ({
  registerShellHandlers: registerShellHandlersMock
}))

vi.mock('./pet', () => ({
  registerPetHandlers: registerPetHandlersMock
}))

vi.mock('./session', () => ({
  registerSessionHandlers: registerSessionHandlersMock
}))

vi.mock('./ui', () => ({
  registerUIHandlers: registerUIHandlersMock
}))

vi.mock('./filesystem', () => ({
  registerFilesystemHandlers: registerFilesystemHandlersMock
}))

vi.mock('./filesystem-watcher', () => ({
  registerFilesystemWatcherHandlers: registerFilesystemWatcherHandlersMock
}))

vi.mock('./rate-limits', () => ({
  registerRateLimitHandlers: registerRateLimitHandlersMock
}))

vi.mock('./runtime', () => ({
  registerRuntimeHandlers: registerRuntimeHandlersMock
}))

vi.mock('./codex-accounts', () => ({
  registerCodexAccountHandlers: registerCodexAccountHandlersMock
}))

vi.mock('./agent-hooks', () => ({
  registerAgentHookHandlers: registerAgentHookHandlersMock
}))

vi.mock('./agent-trust', () => ({
  registerAgentTrustHandlers: registerAgentTrustHandlersMock
}))

vi.mock('./claude-accounts', () => ({
  registerClaudeAccountHandlers: registerClaudeAccountHandlersMock
}))

vi.mock('../window/attach-main-window-services', () => ({
  registerClipboardHandlers: registerClipboardHandlersMock,
  registerUpdaterHandlers: registerUpdaterHandlersMock
}))

vi.mock('./browser', () => ({
  registerBrowserHandlers: registerBrowserHandlersMock,
  setTrustedBrowserRendererWebContentsId: setTrustedBrowserRendererWebContentsIdMock,
  setAgentBrowserBridgeRef: setAgentBrowserBridgeRefMock
}))

vi.mock('./app', () => ({
  registerAppHandlers: registerAppHandlersMock
}))

vi.mock('./linear', () => ({
  registerLinearHandlers: registerLinearHandlersMock
}))

import { registerCoreHandlers } from './register-core-handlers'

describe('registerCoreHandlers', () => {
  beforeEach(() => {
    registerCliHandlersMock.mockReset()
    registerPreflightHandlersMock.mockReset()
    registerClaudeUsageHandlersMock.mockReset()
    registerCodexUsageHandlersMock.mockReset()
    registerGitHubHandlersMock.mockReset()
    registerFeedbackHandlersMock.mockReset()
    registerStatsHandlersMock.mockReset()
    registerMemoryHandlersMock.mockReset()
    registerNotebookHandlersMock.mockReset()
    registerNotesHandlersMock.mockReset()
    registerNotificationHandlersMock.mockReset()
    registerDeveloperPermissionHandlersMock.mockReset()
    registerComputerUsePermissionHandlersMock.mockReset()
    registerSettingsHandlersMock.mockReset()
    registerTelemetryHandlersMock.mockReset()
    registerShellHandlersMock.mockReset()
    registerPetHandlersMock.mockReset()
    registerSessionHandlersMock.mockReset()
    registerUIHandlersMock.mockReset()
    registerFilesystemHandlersMock.mockReset()
    registerRuntimeHandlersMock.mockReset()
    registerCodexAccountHandlersMock.mockReset()
    registerAgentHookHandlersMock.mockReset()
    registerAgentTrustHandlersMock.mockReset()
    registerClaudeAccountHandlersMock.mockReset()
    registerClipboardHandlersMock.mockReset()
    registerUpdaterHandlersMock.mockReset()
    registerRateLimitHandlersMock.mockReset()
    registerBrowserHandlersMock.mockReset()
    setAgentBrowserBridgeRefMock.mockReset()
    setTrustedBrowserRendererWebContentsIdMock.mockReset()
    registerFilesystemWatcherHandlersMock.mockReset()
    registerAppHandlersMock.mockReset()
    registerLinearHandlersMock.mockReset()
    registerExportHandlersMock.mockReset()
    registerSpeechHandlersMock.mockReset()
  })

  it('passes the store through to handler registrars that need it', () => {
    const store = { marker: 'store' }
    const runtime = { marker: 'runtime', getAgentBrowserBridge: () => null }
    const stats = { marker: 'stats' }
    const claudeUsage = { marker: 'claudeUsage' }
    const codexUsage = { marker: 'codexUsage' }
    const codexAccounts = { marker: 'codexAccounts' }
    const claudeAccounts = { marker: 'claudeAccounts' }
    const rateLimits = { marker: 'rateLimits' }

    registerCoreHandlers(
      store as never,
      runtime as never,
      stats as never,
      claudeUsage as never,
      codexUsage as never,
      codexAccounts as never,
      claudeAccounts as never,
      rateLimits as never
    )

    expect(registerClaudeUsageHandlersMock).toHaveBeenCalledWith(claudeUsage)
    expect(registerCodexUsageHandlersMock).toHaveBeenCalledWith(codexUsage)
    expect(registerCodexAccountHandlersMock).toHaveBeenCalledWith(codexAccounts)
    expect(registerAgentHookHandlersMock).toHaveBeenCalled()
    expect(registerPetHandlersMock).toHaveBeenCalled()
    expect(registerClaudeAccountHandlersMock).toHaveBeenCalledWith(claudeAccounts)
    expect(registerRateLimitHandlersMock).toHaveBeenCalledWith(rateLimits)
    expect(registerGitHubHandlersMock).toHaveBeenCalledWith(store, stats)
    expect(registerLinearHandlersMock).toHaveBeenCalled()
    expect(registerFeedbackHandlersMock).toHaveBeenCalled()
    expect(registerStatsHandlersMock).toHaveBeenCalledWith(stats)
    expect(registerMemoryHandlersMock).toHaveBeenCalledWith(store)
    expect(registerNotebookHandlersMock).toHaveBeenCalledWith(store)
    expect(registerNotificationHandlersMock).toHaveBeenCalledWith(store, runtime)
    expect(registerDeveloperPermissionHandlersMock).toHaveBeenCalled()
    expect(registerComputerUsePermissionHandlersMock).toHaveBeenCalled()
    expect(registerSettingsHandlersMock).toHaveBeenCalledWith(store)
    expect(registerTelemetryHandlersMock).toHaveBeenCalledWith(store)
    expect(registerSessionHandlersMock).toHaveBeenCalledWith(store)
    expect(registerUIHandlersMock).toHaveBeenCalledWith(store)
    expect(registerFilesystemHandlersMock).toHaveBeenCalledWith(store)
    expect(registerRuntimeHandlersMock).toHaveBeenCalledWith(runtime)
    expect(registerCliHandlersMock).toHaveBeenCalled()
    expect(registerPreflightHandlersMock).toHaveBeenCalled()
    expect(registerShellHandlersMock).toHaveBeenCalled()
    expect(registerClipboardHandlersMock).toHaveBeenCalled()
    expect(registerUpdaterHandlersMock).toHaveBeenCalled()
    expect(setTrustedBrowserRendererWebContentsIdMock).toHaveBeenCalledWith(null)
    expect(registerBrowserHandlersMock).toHaveBeenCalled()
    expect(registerFilesystemWatcherHandlersMock).toHaveBeenCalled()
    expect(registerSpeechHandlersMock).toHaveBeenCalledWith(store)
  })

  it('only registers IPC handlers once but always updates web contents id', () => {
    // The first test already called registerCoreHandlers, so the module-level
    // guard is now set. beforeEach reset all mocks, so call counts are 0.
    const store2 = { marker: 'store2' }
    const runtime2 = { marker: 'runtime2', getAgentBrowserBridge: () => null }
    const stats2 = { marker: 'stats2' }
    const claudeUsage2 = { marker: 'claudeUsage2' }
    const codexUsage2 = { marker: 'codexUsage2' }
    const codexAccounts2 = { marker: 'codexAccounts2' }
    const claudeAccounts2 = { marker: 'claudeAccounts2' }
    const rateLimits2 = { marker: 'rateLimits2' }

    registerCoreHandlers(
      store2 as never,
      runtime2 as never,
      stats2 as never,
      claudeUsage2 as never,
      codexUsage2 as never,
      codexAccounts2 as never,
      claudeAccounts2 as never,
      rateLimits2 as never,
      42
    )

    // Web contents ID should always be updated
    expect(setTrustedBrowserRendererWebContentsIdMock).toHaveBeenCalledWith(42)
    // IPC handlers should NOT be registered again
    expect(registerCliHandlersMock).not.toHaveBeenCalled()
    expect(registerPreflightHandlersMock).not.toHaveBeenCalled()
    expect(registerBrowserHandlersMock).not.toHaveBeenCalled()
    // Why: ipcMain.handle throws on duplicate channel registration, so the
    // memory handler must not be wired up a second time on reactivation.
    expect(registerMemoryHandlersMock).not.toHaveBeenCalled()
  })
})
