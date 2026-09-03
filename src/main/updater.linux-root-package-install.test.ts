import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as UpdaterModule from './updater'
import type { LinuxRootPackageType, UpdateStatus } from '../shared/update-status-types'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  killAllPtyMock,
  getLinuxPackageTypeMock,
  getLinuxRootPackageTypeMock,
  recordUpdaterLifecycleMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

const packageSha512 = Buffer.alloc(64).toString('base64')

function downloadedEvent(packageType: LinuxRootPackageType): Record<string, unknown> {
  const fileName =
    packageType === 'deb' ? 'orca-ide_1.0.61_amd64.deb' : 'orca-ide-1.0.61.x86_64.rpm'
  return {
    version: '1.0.61',
    downloadedFile: join(tmpdir(), 'orca-updater', 'pending', fileName),
    files: [{ url: fileName, sha512: packageSha512 }]
  }
}

warmUpdaterModule()

describe('updater Linux root packages', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  async function startUpdater(
    packageType: LinuxRootPackageType | null,
    installMode: UpdaterModule.UpdateInstallMode = 'interactive'
  ): Promise<{ send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule }> {
    getLinuxRootPackageTypeMock.mockReturnValue(packageType)
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode
    })
    return { send, updater }
  }

  function lastStatus(send: ReturnType<typeof vi.fn>): UpdateStatus | undefined {
    return send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]
  }

  function markMacInstallerReady(): void {
    if (process.platform !== 'darwin') {
      return
    }
    const handler = nativeUpdaterMock.on.mock.calls.find(
      ([eventName]) => eventName === 'update-downloaded'
    )?.[1] as (() => void) | undefined
    handler?.()
  }

  async function reachDownloaded(
    updater: typeof UpdaterModule,
    event: Record<string, unknown>,
    markInstallerReady = false
  ): Promise<void> {
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.downloadUpdate.mockResolvedValue([])
    updater.downloadUpdate()
    autoUpdaterMock.emit('update-downloaded', event)
    if (markInstallerReady) {
      markMacInstallerReady()
    }
    await vi.advanceTimersByTimeAsync(0)
  }

  it.each(['deb', 'rpm'] as const)(
    'hands off %s installs without invoking the native updater',
    async (packageType) => {
      const openWindow = { removeAllListeners: vi.fn() }
      browserWindowMock.getAllWindows.mockReturnValue([openWindow] as never)
      const { send, updater } = await startUpdater(packageType)

      await reachDownloaded(updater, downloadedEvent(packageType))

      expect(lastStatus(send)).toEqual({
        state: 'error',
        message: 'Quit Orca before running the system package install command.',
        recovery: {
          kind: 'linux-package-install',
          packageType,
          reason: 'manual-install-required',
          version: '1.0.61'
        }
      })

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(openWindow.removeAllListeners).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_manual_install_required',
        { packageType, version: '1.0.61' }
      )
    }
  )

  it('guards the native boundary even when no package artifact was retained', async () => {
    const { send, updater } = await startUpdater('deb')

    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
  })

  it('preserves the normal AppImage install path when no root-package marker is present', async () => {
    const { send, updater } = await startUpdater(null)
    await reachDownloaded(
      updater,
      {
        version: '1.0.61',
        downloadedFile: join(tmpdir(), 'Orca-1.0.61.AppImage'),
        files: []
      },
      true
    )

    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalledWith('updater:quitAndInstallAborted')
    expect(
      send.mock.calls.some(
        ([channel, status]) =>
          channel === 'updater:status' &&
          (status as UpdateStatus).state === 'error' &&
          (status as Extract<UpdateStatus, { state: 'error' }>).recovery?.kind ===
            'linux-package-install'
      )
    ).toBe(false)
  })

  it.each(['deb', 'rpm'] as const)(
    'disables install-on-quit and remote automatic control for %s builds',
    async (packageType) => {
      autoUpdaterMock.autoInstallOnAppQuit = true
      const { updater } = await startUpdater(packageType)

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      expect(updater.getRemoteServerUpdateSupport()).toEqual({
        installMode: 'interactive',
        automatic: false,
        reason: 'manual-service-update-required'
      })
      expect(() => updater.checkForRemoteServerUpdate('runtime-1')).toThrow(
        'remote_update_manual_required'
      )
    }
  )

  it('keeps interactive install-on-quit and remote control for non-root packages', async () => {
    autoUpdaterMock.autoInstallOnAppQuit = false
    const { updater } = await startUpdater(null)

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(updater.getRemoteServerUpdateSupport()).toEqual({
      installMode: 'interactive',
      automatic: true,
      reason: 'available'
    })
  })

  it('fails closed for an unusable packaged marker', async () => {
    getLinuxPackageTypeMock.mockReturnValue('unusable')
    getLinuxRootPackageTypeMock.mockReturnValue(null)
    autoUpdaterMock.autoInstallOnAppQuit = true
    const { send, updater } = await startUpdater(null)

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(updater.getRemoteServerUpdateSupport()).toEqual({
      installMode: 'interactive',
      automatic: false,
      reason: 'manual-service-update-required'
    })

    await reachDownloaded(updater, {
      version: '1.0.61',
      downloadedFile: join(tmpdir(), 'orca-updater', 'pending', 'orca-ide_1.0.61_amd64.deb'),
      files: [{ url: 'orca-ide_1.0.61_amd64.deb', sha512: packageSha512 }]
    })
    expect(lastStatus(send)).toEqual({
      state: 'error',
      message:
        'Orca could not verify the installed Linux package format, so it will not install this update automatically. Download the update from the official release page and install it manually.',
      version: '1.0.61',
      retryable: false
    })

    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
  })

  it('leaves headless serve installs supervisor-controlled', async () => {
    for (const installMode of [
      'supervised-headless-serve',
      'unsupported-headless-serve'
    ] as const) {
      resetUpdaterMocks()
      autoUpdaterMock.autoInstallOnAppQuit = true
      await startUpdater(null, installMode)
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    }
  })
})
