import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  registerCliHandlersMock,
  registerPreflightHandlersMock,
  registerClaudeUsageHandlersMock,
  registerCodexUsageHandlersMock,
  registerGitHubHandlersMock,
  registerFeedbackHandlersMock,
  registerStatsHandlersMock,
  registerNotificationHandlersMock,
  registerSettingsHandlersMock,
  registerShellHandlersMock,
  registerSessionHandlersMock,
  registerUIHandlersMock,
  registerFilesystemHandlersMock,
  registerRuntimeHandlersMock,
  registerCodexAccountHandlersMock,
  registerAgentHookHandlersMock,
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
  registerExportHandlersMock
} = vi.hoisted(() => ({
  registerCliHandlersMock: vi.fn(),
  registerPreflightHandlersMock: vi.fn(),
  registerClaudeUsageHandlersMock: vi.fn(),
  registerCodexUsageHandlersMock: vi.fn(),
  registerGitHubHandlersMock: vi.fn(),
  registerFeedbackHandlersMock: vi.fn(),
  registerStatsHandlersMock: vi.fn(),
  registerNotificationHandlersMock: vi.fn(),
  registerSettingsHandlersMock: vi.fn(),
  registerShellHandlersMock: vi.fn(),
  registerSessionHandlersMock: vi.fn(),
  registerUIHandlersMock: vi.fn(),
  registerFilesystemHandlersMock: vi.fn(),
  registerRuntimeHandlersMock: vi.fn(),
  registerCodexAccountHandlersMock: vi.fn(),
  registerAgentHookHandlersMock: vi.fn(),
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
  registerExportHandlersMock: vi.fn()
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

vi.mock('./notifications', () => ({
  registerNotificationHandlers: registerNotificationHandlersMock
}))

vi.mock('./settings', () => ({
  registerSettingsHandlers: registerSettingsHandlersMock
}))

vi.mock('./shell', () => ({
  registerShellHandlers: registerShellHandlersMock
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
    registerNotificationHandlersMock.mockReset()
    registerSettingsHandlersMock.mockReset()
    registerShellHandlersMock.mockReset()
    registerSessionHandlersMock.mockReset()
    registerUIHandlersMock.mockReset()
    registerFilesystemHandlersMock.mockReset()
    registerRuntimeHandlersMock.mockReset()
    registerCodexAccountHandlersMock.mockReset()
    registerAgentHookHandlersMock.mockReset()
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
    expect(registerClaudeAccountHandlersMock).toHaveBeenCalledWith(claudeAccounts)
    expect(registerRateLimitHandlersMock).toHaveBeenCalledWith(rateLimits)
    expect(registerGitHubHandlersMock).toHaveBeenCalledWith(store, stats)
    expect(registerLinearHandlersMock).toHaveBeenCalled()
    expect(registerFeedbackHandlersMock).toHaveBeenCalled()
    expect(registerStatsHandlersMock).toHaveBeenCalledWith(stats)
    expect(registerNotificationHandlersMock).toHaveBeenCalledWith(store)
    expect(registerSettingsHandlersMock).toHaveBeenCalledWith(store)
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
  })
})
