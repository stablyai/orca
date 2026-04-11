import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  registerCliHandlersMock,
  registerPreflightHandlersMock,
  registerClaudeUsageHandlersMock,
  registerCodexUsageHandlersMock,
  registerGitHubHandlersMock,
  registerStatsHandlersMock,
  registerNotificationHandlersMock,
  registerSettingsHandlersMock,
  registerShellHandlersMock,
  registerSessionHandlersMock,
  registerUIHandlersMock,
  registerFilesystemHandlersMock,
  registerRuntimeHandlersMock,
  registerClipboardHandlersMock,
  registerUpdaterHandlersMock,
  registerBrowserHandlersMock,
  setTrustedBrowserRendererWebContentsIdMock,
  registerFilesystemWatcherHandlersMock
} = vi.hoisted(() => ({
  registerCliHandlersMock: vi.fn(),
  registerPreflightHandlersMock: vi.fn(),
  registerClaudeUsageHandlersMock: vi.fn(),
  registerCodexUsageHandlersMock: vi.fn(),
  registerGitHubHandlersMock: vi.fn(),
  registerStatsHandlersMock: vi.fn(),
  registerNotificationHandlersMock: vi.fn(),
  registerSettingsHandlersMock: vi.fn(),
  registerShellHandlersMock: vi.fn(),
  registerSessionHandlersMock: vi.fn(),
  registerUIHandlersMock: vi.fn(),
  registerFilesystemHandlersMock: vi.fn(),
  registerRuntimeHandlersMock: vi.fn(),
  registerClipboardHandlersMock: vi.fn(),
  registerUpdaterHandlersMock: vi.fn(),
  registerBrowserHandlersMock: vi.fn(),
  setTrustedBrowserRendererWebContentsIdMock: vi.fn(),
  registerFilesystemWatcherHandlersMock: vi.fn()
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

vi.mock('./runtime', () => ({
  registerRuntimeHandlers: registerRuntimeHandlersMock
}))

vi.mock('../window/attach-main-window-services', () => ({
  registerClipboardHandlers: registerClipboardHandlersMock,
  registerUpdaterHandlers: registerUpdaterHandlersMock
}))

vi.mock('./browser', () => ({
  registerBrowserHandlers: registerBrowserHandlersMock,
  setTrustedBrowserRendererWebContentsId: setTrustedBrowserRendererWebContentsIdMock
}))

import { registerCoreHandlers } from './register-core-handlers'

describe('registerCoreHandlers', () => {
  beforeEach(() => {
    registerCliHandlersMock.mockReset()
    registerPreflightHandlersMock.mockReset()
    registerClaudeUsageHandlersMock.mockReset()
    registerCodexUsageHandlersMock.mockReset()
    registerGitHubHandlersMock.mockReset()
    registerStatsHandlersMock.mockReset()
    registerNotificationHandlersMock.mockReset()
    registerSettingsHandlersMock.mockReset()
    registerShellHandlersMock.mockReset()
    registerSessionHandlersMock.mockReset()
    registerUIHandlersMock.mockReset()
    registerFilesystemHandlersMock.mockReset()
    registerRuntimeHandlersMock.mockReset()
    registerClipboardHandlersMock.mockReset()
    registerUpdaterHandlersMock.mockReset()
    registerBrowserHandlersMock.mockReset()
    setTrustedBrowserRendererWebContentsIdMock.mockReset()
    registerFilesystemWatcherHandlersMock.mockReset()
  })

  it('passes the store through to handler registrars that need it', () => {
    const store = { marker: 'store' }
    const runtime = { marker: 'runtime' }
    const stats = { marker: 'stats' }
    const claudeUsage = { marker: 'claudeUsage' }
    const codexUsage = { marker: 'codexUsage' }

    registerCoreHandlers(
      store as never,
      runtime as never,
      stats as never,
      claudeUsage as never,
      codexUsage as never
    )

    expect(registerClaudeUsageHandlersMock).toHaveBeenCalledWith(claudeUsage)
    expect(registerCodexUsageHandlersMock).toHaveBeenCalledWith(codexUsage)
    expect(registerGitHubHandlersMock).toHaveBeenCalledWith(store, stats)
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
})
