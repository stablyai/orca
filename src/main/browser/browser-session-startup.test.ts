import { beforeEach, describe, expect, it, vi } from 'vitest'

function installRegistryMock(): {
  configureForMCodeProfileMock: ReturnType<typeof vi.fn>
  applyPendingCookieImportMock: ReturnType<typeof vi.fn>
  initializeBrowserSessionsFromPersistedStateMock: ReturnType<typeof vi.fn>
} {
  const configureForMCodeProfileMock = vi.fn()
  const applyPendingCookieImportMock = vi.fn()
  const initializeBrowserSessionsFromPersistedStateMock = vi.fn()

  vi.doMock('./browser-session-registry', () => ({
    browserSessionRegistry: {
      configureForMCodeProfile: configureForMCodeProfileMock,
      applyPendingCookieImport: applyPendingCookieImportMock,
      initializeBrowserSessionsFromPersistedState: initializeBrowserSessionsFromPersistedStateMock
    }
  }))

  return {
    configureForMCodeProfileMock,
    applyPendingCookieImportMock,
    initializeBrowserSessionsFromPersistedStateMock
  }
}

describe('initializeBrowserSessionsForApp', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('replays pending cookie imports before initializing browser sessions', async () => {
    const { applyPendingCookieImportMock, initializeBrowserSessionsFromPersistedStateMock } =
      installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp()

    expect(applyPendingCookieImportMock).toHaveBeenCalledOnce()
    expect(initializeBrowserSessionsFromPersistedStateMock).toHaveBeenCalledOnce()
    expect(applyPendingCookieImportMock.mock.invocationCallOrder[0]).toBeLessThan(
      initializeBrowserSessionsFromPersistedStateMock.mock.invocationCallOrder[0]
    )
  })

  it('configures the active MCode profile before replaying browser sessions', async () => {
    const {
      configureForMCodeProfileMock,
      applyPendingCookieImportMock,
      initializeBrowserSessionsFromPersistedStateMock
    } = installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp({
      mcodeProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })

    expect(configureForMCodeProfileMock).toHaveBeenCalledWith({
      mcodeProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })
    expect(configureForMCodeProfileMock.mock.invocationCallOrder[0]).toBeLessThan(
      applyPendingCookieImportMock.mock.invocationCallOrder[0]
    )
    expect(applyPendingCookieImportMock.mock.invocationCallOrder[0]).toBeLessThan(
      initializeBrowserSessionsFromPersistedStateMock.mock.invocationCallOrder[0]
    )
  })

  it('initializes browser sessions once per app process', async () => {
    const { applyPendingCookieImportMock, initializeBrowserSessionsFromPersistedStateMock } =
      installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp()
    initializeBrowserSessionsForApp()

    expect(applyPendingCookieImportMock).toHaveBeenCalledOnce()
    expect(initializeBrowserSessionsFromPersistedStateMock).toHaveBeenCalledOnce()
  })

  it('retries if initialization fails before completion', async () => {
    const { applyPendingCookieImportMock, initializeBrowserSessionsFromPersistedStateMock } =
      installRegistryMock()
    initializeBrowserSessionsFromPersistedStateMock.mockImplementationOnce(() => {
      throw new Error('session init failed')
    })
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    expect(() => initializeBrowserSessionsForApp()).toThrow('session init failed')
    initializeBrowserSessionsForApp()

    expect(applyPendingCookieImportMock).toHaveBeenCalledTimes(2)
    expect(initializeBrowserSessionsFromPersistedStateMock).toHaveBeenCalledTimes(2)
  })
})
