import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildReleaseLookupResponse,
  getFallbackAssetUrl,
  releaseTagUrl
} from './updater.test-fixtures'

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, shellMock, isMock } =
  vi.hoisted(() => {
    const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? []
      handlers.push(handler)
      eventHandlers.set(event, handlers)
      return autoUpdaterMock
    })

    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const reset = () => {
      eventHandlers.clear()
      on.mockClear()
      autoUpdaterMock.checkForUpdates.mockReset()
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
    }

    const autoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      on,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      emit,
      reset
    }

    return {
      appMock: {
        isPackaged: true,
        getVersion: vi.fn(() => '1.0.51'),
        on: vi.fn(),
        quit: vi.fn()
      },
      browserWindowMock: {
        getAllWindows: vi.fn(() => [])
      },
      nativeUpdaterMock: {
        on: vi.fn()
      },
      autoUpdaterMock,
      shellMock: {
        openExternal: vi.fn()
      },
      isMock: { dev: false }
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  shell: shellMock
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: vi.fn()
}))

describe('updater fallback', () => {
  const fallbackAssetUrl = getFallbackAssetUrl()
  const latestMacYmlError = 'Cannot find channel "latest-mac.yml" update info: HttpError: 404'

  function mockReleaseLookupResponse(releases = buildReleaseLookupResponse()): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => releases
      }))
    )
  }

  function mockCheckFailure(message: string): void {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error(message))
      })
      return Promise.reject(new Error(message))
    })
  }

  function getStatuses(sendMock: ReturnType<typeof vi.fn>): unknown[] {
    return sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
  }

  async function expectFallbackAvailable(
    sendMock: ReturnType<typeof vi.fn>,
    manualDownloadUrl = fallbackAssetUrl
  ): Promise<void> {
    await vi.waitFor(() => {
      expect(getStatuses(sendMock)).toContainEqual({
        state: 'available',
        version: '1.0.61',
        releaseUrl: releaseTagUrl,
        manualDownloadUrl
      })
    })
  }

  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    shellMock.openExternal.mockReset()
    shellMock.openExternal.mockResolvedValue(true)
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.isPackaged = true
    isMock.dev = false
    vi.unstubAllGlobals()
  })

  it('compares prerelease and build semver strings correctly', async () => {
    const { compareVersions } = await import('./updater-fallback')

    expect(compareVersions('1.0.70-rc.1', '1.0.69')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70', '1.0.70-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70+build.5', '1.0.70')).toBe(0)
    expect(compareVersions('v1.0.70-beta.2', '1.0.70-beta.1')).toBeGreaterThan(0)
  })

  it('falls back to the latest stable GitHub release when GitHub reports no published versions', async () => {
    mockReleaseLookupResponse()
    mockCheckFailure('No published versions on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await expectFallbackAvailable(sendMock)
  })

  it('opens the fallback download URL instead of using electron-updater', async () => {
    mockReleaseLookupResponse(buildReleaseLookupResponse().slice(1))
    mockCheckFailure(latestMacYmlError)

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await expectFallbackAvailable(sendMock)

    downloadUpdate()

    expect(shellMock.openExternal).toHaveBeenCalledWith(fallbackAssetUrl)
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
  })

  it('preserves the fallback release URL when the update becomes downloaded', async () => {
    mockReleaseLookupResponse(buildReleaseLookupResponse().slice(1))
    mockCheckFailure(latestMacYmlError)

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('error', new Error(latestMacYmlError))

    await expectFallbackAvailable(sendMock)

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'downloaded',
        version: '1.0.61',
        releaseUrl: releaseTagUrl
      })
    })
  })

  it('surfaces manual download launcher failures', async () => {
    mockReleaseLookupResponse(buildReleaseLookupResponse().slice(1))
    shellMock.openExternal.mockRejectedValueOnce(new Error('launcher blocked'))
    mockCheckFailure(latestMacYmlError)

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await expectFallbackAvailable(sendMock)

    downloadUpdate()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'launcher blocked',
        userInitiated: undefined
      })
    })
  })

  it('clears fallback release metadata before a later check reports no update', async () => {
    mockReleaseLookupResponse(buildReleaseLookupResponse().slice(1))
    mockCheckFailure(latestMacYmlError)

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await expectFallbackAvailable(sendMock)

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: undefined
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'downloaded',
      version: '1.0.61',
      releaseUrl: releaseTagUrl
    })
  })
})
