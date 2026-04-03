import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReleaseLookupResponse, releaseTagUrl } from './updater.test-fixtures'

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

describe('updater fallback asset selection', () => {
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

  async function expectFallbackAvailable(
    sendMock: ReturnType<typeof vi.fn>,
    manualDownloadUrl: string
  ): Promise<void> {
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
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

  it.runIf(process.platform === 'darwin')(
    'prefers the fallback asset that matches the current macOS architecture',
    async () => {
      const preferredAssetUrl =
        process.arch === 'arm64'
          ? 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-arm64.dmg'
          : 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-x64.dmg'
      const nonPreferredAssetUrl =
        process.arch === 'arm64'
          ? 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-x64.dmg'
          : 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-arm64.dmg'

      mockReleaseLookupResponse([
        {
          draft: false,
          prerelease: false,
          tag_name: 'v1.0.61',
          html_url: releaseTagUrl,
          assets: [
            {
              name: process.arch === 'arm64' ? 'orca-macos-x64.dmg' : 'orca-macos-arm64.dmg',
              browser_download_url: nonPreferredAssetUrl
            },
            {
              name: process.arch === 'arm64' ? 'orca-macos-arm64.dmg' : 'orca-macos-x64.dmg',
              browser_download_url: preferredAssetUrl
            }
          ]
        }
      ])
      mockCheckFailure('Unable to find latest version on GitHub')

      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      checkForUpdatesFromMenu()
      await expectFallbackAvailable(sendMock, preferredAssetUrl)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'prefers the dmg over the zip for the matching macOS architecture',
    async () => {
      const matchingArch = process.arch === 'arm64' ? 'arm64' : 'x64'
      const dmgUrl = `https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-${matchingArch}.dmg`
      const zipUrl = `https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-${matchingArch}.zip`

      mockReleaseLookupResponse([
        {
          draft: false,
          prerelease: false,
          tag_name: 'v1.0.61',
          html_url: releaseTagUrl,
          assets: [
            {
              name: `orca-macos-${matchingArch}.zip`,
              browser_download_url: zipUrl
            },
            {
              name: `orca-macos-${matchingArch}.dmg`,
              browser_download_url: dmgUrl
            }
          ]
        }
      ])
      mockCheckFailure('Unable to find latest version on GitHub')

      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      checkForUpdatesFromMenu()
      await expectFallbackAvailable(sendMock, dmgUrl)
    }
  )
})
