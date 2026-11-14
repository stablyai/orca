import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../shared/update-status-types'
import type * as UpdaterModule from './updater-service'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  appMock,
  autoUpdaterMock,
  clearTrackedLinuxPackageArtifactMock,
  getTrackedLinuxPackageArtifactMock,
  recordUpdaterLifecycleMock,
  resolveLinuxPackageInstallInstructionsMock,
  resolveLinuxPackageRevealTargetMock,
  showItemInFolderMock,
  resetHandlers
} = vi.hoisted(() => {
  const updaterHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    logger: undefined as { error: (message: unknown) => void } | undefined,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterHandlers.set(event, [...(updaterHandlers.get(event) ?? []), handler])
      return autoUpdaterMock
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of updaterHandlers.get(event) ?? []) {
        handler(...args)
      }
    }
  }
  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: vi.fn(),
      prependListener: vi.fn(),
      quit: vi.fn()
    },
    autoUpdaterMock,
    clearTrackedLinuxPackageArtifactMock: vi.fn(),
    getTrackedLinuxPackageArtifactMock: vi.fn(),
    recordUpdaterLifecycleMock: vi.fn(),
    resolveLinuxPackageInstallInstructionsMock: vi.fn(),
    resolveLinuxPackageRevealTargetMock: vi.fn(),
    showItemInFolderMock: vi.fn(),
    resetHandlers: () => updaterHandlers.clear()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  autoUpdater: { on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: { showItemInFolder: showItemInFolderMock },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }))
vi.mock('../ipc/pty/kill-all', () => ({ killAllPty: vi.fn() }))
vi.mock('./releases/updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./nudges/nudge-campaign', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi.fn().mockResolvedValue({ tags: [], state: 'no-newer' }),
  getReleaseDownloadUrl: vi.fn(() => 'https://example.invalid/download')
}))
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: vi.fn(),
  disarmUpdateInstallExitWatchdog: vi.fn()
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./linux-package/linux-update-package-type', () => ({
  getLinuxPackageType: () => 'deb',
  getLinuxRootPackageType: () => 'deb',
  isExternallyManagedLinuxInstall: () => false
}))
vi.mock('./linux-package/linux-package-update-recovery', () => ({
  captureLinuxPackageArtifact: vi.fn(() => getTrackedLinuxPackageArtifactMock()),
  clearTrackedLinuxPackageArtifact: clearTrackedLinuxPackageArtifactMock,
  clearTrackedLinuxPackageArtifactForOtherVersion: vi.fn(),
  getTrackedLinuxPackageArtifact: getTrackedLinuxPackageArtifactMock,
  resolveLinuxPackageInstallInstructions: resolveLinuxPackageInstallInstructionsMock,
  resolveLinuxPackageRevealTarget: resolveLinuxPackageRevealTargetMock
}))

const ARTIFACT = {
  packageType: 'deb' as const,
  version: '1.0.61',
  path: '/home/tester/.cache/orca-updater/pending/orca-ide_1.0.61_amd64.deb',
  sha512: 'LHlL7dKoqg98gS2nfQv878dK+UoktbAkm4M20/hoJ2Qr0Kqsa3MSL4VmWy/Lll/MYjQFkpvOxduQ/vswentozA=='
}

warmUpdaterModule()

describe('linux package recovery actions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    resetHandlers()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue([])
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockReset()
    autoUpdaterMock.on.mockClear()
    appMock.on.mockClear()
    clearTrackedLinuxPackageArtifactMock.mockReset()
    getTrackedLinuxPackageArtifactMock.mockReset().mockReturnValue(ARTIFACT)
    recordUpdaterLifecycleMock.mockReset()
    resolveLinuxPackageInstallInstructionsMock
      .mockReset()
      .mockResolvedValue({ ok: true, command: "sudo apt install -- '<pkg>'", packageFileName: 'p' })
    resolveLinuxPackageRevealTargetMock
      .mockReset()
      .mockResolvedValue({ ok: true, path: ARTIFACT.path })
    showItemInFolderMock.mockReset()
  })

  const startUpdater = async (): Promise<{
    send: ReturnType<typeof vi.fn>
    updater: typeof UpdaterModule
  }> => {
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(updaterMainWindow(send), {
      getLastUpdateCheckAt: () => Date.now()
    })
    return { send, updater }
  }

  const activateRecovery = async (
    updater: typeof UpdaterModule,
    version = '1.0.61'
  ): Promise<void> => {
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version }))
      return Promise.resolve(null)
    })
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    updater.downloadUpdate()
    autoUpdaterMock.emit('update-downloaded', { version })
  }

  type ErrorStatus = Extract<UpdateStatus, { state: 'error' }>

  const errorStatuses = (send: ReturnType<typeof vi.fn>): ErrorStatus[] =>
    send.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status as UpdateStatus)
      .filter((status): status is ErrorStatus => status.state === 'error')

  it('replaces the structured status when revalidation fails so stale actions die', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    resolveLinuxPackageInstallInstructionsMock.mockResolvedValue({
      ok: false,
      reason: 'hash-mismatch'
    })

    await expect(updater.getLinuxPackageInstallInstructions()).rejects.toThrow(
      'no longer matches the verified release'
    )

    expect(clearTrackedLinuxPackageArtifactMock).toHaveBeenCalledTimes(1)
    const latest = errorStatuses(send).at(-1)
    expect(latest?.state === 'error' && latest.recovery).toBeUndefined()
    expect(latest?.version).toBe('1.0.61')
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'linux_package_recovery_unavailable',
      { reason: 'hash-mismatch', packageType: 'deb', version: '1.0.61' },
      expect.objectContaining({ level: 'warn' })
    )
    await expect(updater.showLinuxPackage()).rejects.toThrow(
      'No package install recovery is available.'
    )
    expect(resolveLinuxPackageRevealTargetMock).not.toHaveBeenCalled()
  })

  it('ignores a stale mismatch after the same package cycle is captured again', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    let settleValidation!: (result: { ok: false; reason: 'hash-mismatch' }) => void
    resolveLinuxPackageInstallInstructionsMock.mockReturnValue(
      new Promise((resolve) => {
        settleValidation = resolve
      })
    )

    const pending = updater.getLinuxPackageInstallInstructions()
    // Hashing can outlive its download cycle; replace the recovery while validation is pending.
    getTrackedLinuxPackageArtifactMock.mockReturnValue({ ...ARTIFACT })
    await activateRecovery(updater)
    settleValidation({ ok: false, reason: 'hash-mismatch' })

    await expect(pending).rejects.toThrow('Package install recovery is no longer current.')
    expect(clearTrackedLinuxPackageArtifactMock).not.toHaveBeenCalled()
    expect(errorStatuses(send).at(-1)?.recovery?.version).toBe('1.0.61')
  })

  it('does not return stale instructions after a same-version recapture', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    let settleValidation!: (result: { ok: true; command: string; packageFileName: string }) => void
    resolveLinuxPackageInstallInstructionsMock.mockReturnValue(
      new Promise((resolve) => {
        settleValidation = resolve
      })
    )

    const pending = updater.getLinuxPackageInstallInstructions()
    getTrackedLinuxPackageArtifactMock.mockReturnValue({ ...ARTIFACT })
    await activateRecovery(updater)
    const statusesBefore = errorStatuses(send).length
    settleValidation({ ok: true, command: 'stale command', packageFileName: 'stale.deb' })

    await expect(pending).rejects.toThrow('Package install recovery is no longer current.')
    expect(errorStatuses(send)).toHaveLength(statusesBefore)
  })

  it('does not reveal a stale path after a same-version recapture', async () => {
    const { updater } = await startUpdater()
    await activateRecovery(updater)
    let settleValidation!: (result: { ok: true; path: string }) => void
    resolveLinuxPackageRevealTargetMock.mockReturnValue(
      new Promise((resolve) => {
        settleValidation = resolve
      })
    )

    const pending = updater.showLinuxPackage()
    getTrackedLinuxPackageArtifactMock.mockReturnValue({ ...ARTIFACT })
    await activateRecovery(updater)
    settleValidation({ ok: true, path: ARTIFACT.path })

    await expect(pending).rejects.toThrow('Package install recovery is no longer current.')
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })
})
