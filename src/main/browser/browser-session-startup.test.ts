import { beforeEach, describe, expect, it, vi } from 'vitest'

function installRegistryMock(): {
  configureForOrcaProfileMock: ReturnType<typeof vi.fn>
  configureRouteSessionsForOrcaProfileMock: ReturnType<typeof vi.fn>
  configurePairedRuntimeBrowserClientHostsForOrcaProfileMock: ReturnType<typeof vi.fn>
  collectOrphanedBrowserRoutePartitionStorageMock: ReturnType<typeof vi.fn>
  applyPendingCookieImportMock: ReturnType<typeof vi.fn>
  initializeBrowserSessionsFromPersistedStateMock: ReturnType<typeof vi.fn>
} {
  const configureForOrcaProfileMock = vi.fn()
  const configureRouteSessionsForOrcaProfileMock = vi.fn()
  const configurePairedRuntimeBrowserClientHostsForOrcaProfileMock = vi.fn()
  const collectOrphanedBrowserRoutePartitionStorageMock = vi.fn(async () => [])
  const applyPendingCookieImportMock = vi.fn()
  const initializeBrowserSessionsFromPersistedStateMock = vi.fn()

  vi.doMock('./browser-session-registry', () => ({
    browserSessionRegistry: {
      configureForOrcaProfile: configureForOrcaProfileMock,
      applyPendingCookieImport: applyPendingCookieImportMock,
      initializeBrowserSessionsFromPersistedState: initializeBrowserSessionsFromPersistedStateMock
    }
  }))
  vi.doMock('./browser-route-session-runtime', () => ({
    configureRouteSessionsForOrcaProfile: configureRouteSessionsForOrcaProfileMock
  }))
  vi.doMock('./browser-route-partition-storage-runtime', () => ({
    collectOrphanedBrowserRoutePartitionStorage: collectOrphanedBrowserRoutePartitionStorageMock
  }))
  vi.doMock('./paired-runtime-browser-client-host-runtime', () => ({
    configurePairedRuntimeBrowserClientHostsForOrcaProfile:
      configurePairedRuntimeBrowserClientHostsForOrcaProfileMock
  }))

  return {
    configureForOrcaProfileMock,
    configureRouteSessionsForOrcaProfileMock,
    configurePairedRuntimeBrowserClientHostsForOrcaProfileMock,
    collectOrphanedBrowserRoutePartitionStorageMock,
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

  it('configures the active Orca profile before replaying browser sessions', async () => {
    const {
      configureForOrcaProfileMock,
      configureRouteSessionsForOrcaProfileMock,
      configurePairedRuntimeBrowserClientHostsForOrcaProfileMock,
      applyPendingCookieImportMock,
      initializeBrowserSessionsFromPersistedStateMock
    } = installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp({
      orcaProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })

    expect(configureForOrcaProfileMock).toHaveBeenCalledWith({
      orcaProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })
    expect(configureRouteSessionsForOrcaProfileMock).toHaveBeenCalledWith({
      orcaProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })
    expect(configurePairedRuntimeBrowserClientHostsForOrcaProfileMock).toHaveBeenCalledWith({
      orcaProfileId: 'local-work'
    })
    expect(configureForOrcaProfileMock.mock.invocationCallOrder[0]).toBeLessThan(
      applyPendingCookieImportMock.mock.invocationCallOrder[0]
    )
    expect(configureRouteSessionsForOrcaProfileMock.mock.invocationCallOrder[0]).toBeLessThan(
      applyPendingCookieImportMock.mock.invocationCallOrder[0]
    )
    expect(
      configurePairedRuntimeBrowserClientHostsForOrcaProfileMock.mock.invocationCallOrder[0]
    ).toBeLessThan(applyPendingCookieImportMock.mock.invocationCallOrder[0])
    expect(applyPendingCookieImportMock.mock.invocationCallOrder[0]).toBeLessThan(
      initializeBrowserSessionsFromPersistedStateMock.mock.invocationCallOrder[0]
    )
  })

  it('sweeps orphaned route partitions once the profile binding runtime is configured', async () => {
    const {
      configureRouteSessionsForOrcaProfileMock,
      collectOrphanedBrowserRoutePartitionStorageMock
    } = installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp({
      orcaProfileId: 'local-work',
      profileDirectory: '/profiles/local-work'
    })

    expect(collectOrphanedBrowserRoutePartitionStorageMock).toHaveBeenCalledOnce()
    // Hoisting the sweep above the binding runtime leaves it with no active profile and it collects nothing.
    expect(configureRouteSessionsForOrcaProfileMock.mock.invocationCallOrder[0]).toBeLessThan(
      collectOrphanedBrowserRoutePartitionStorageMock.mock.invocationCallOrder[0]
    )
  })

  it('does not sweep route partitions when no profile is active', async () => {
    const { collectOrphanedBrowserRoutePartitionStorageMock } = installRegistryMock()
    const { initializeBrowserSessionsForApp } = await import('./browser-session-startup')

    initializeBrowserSessionsForApp()

    expect(collectOrphanedBrowserRoutePartitionStorageMock).not.toHaveBeenCalled()
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
