import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../shared/update-status-types'
import type * as UpdaterModule from './updater'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

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
    appMock: { isPackaged: true, getVersion: vi.fn(() => '1.0.51'), on: vi.fn(), quit: vi.fn() },
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
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./ipc/pty', () => ({ killAllPty: vi.fn() }))
vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi.fn().mockResolvedValue({ tags: [], state: 'no-newer' }),
  getReleaseDownloadUrl: vi.fn(() => 'https://example.invalid/download')
}))
vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: vi.fn(),
  disarmUpdateInstallExitWatchdog: vi.fn()
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./linux-update-package-type', () => ({
  getLinuxPackageType: () => 'deb',
  getLinuxRootPackageType: () => 'deb',
  isExternallyManagedLinuxInstall: () => false
}))
vi.mock('./linux-package-update-recovery', () => ({
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
const MANUAL_INSTALL_STATUS = {
  state: 'error',
  message: 'Quit Orca before running the system package install command.',
  recovery: {
    kind: 'linux-package-install',
    packageType: 'deb',
    reason: 'manual-install-required',
    version: '1.0.61'
  }
} as const satisfies UpdateStatus

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
    updater.setupAutoUpdater({ webContents: { send } } as never, {
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

  it('rejects both actions while no package-install recovery is active', async () => {
    const { updater } = await startUpdater()

    await expect(updater.getLinuxPackageInstallInstructions()).rejects.toThrow(
      'No package install recovery is available.'
    )
    await expect(updater.showLinuxPackage()).rejects.toThrow(
      'No package install recovery is available.'
    )
    expect(resolveLinuxPackageInstallInstructionsMock).not.toHaveBeenCalled()
    expect(resolveLinuxPackageRevealTargetMock).not.toHaveBeenCalled()
  })

  it('validates the retained package on every invocation', async () => {
    const { updater } = await startUpdater()
    await activateRecovery(updater)

    await expect(updater.getLinuxPackageInstallInstructions()).resolves.toEqual({
      ok: true,
      command: "sudo apt install -- '<pkg>'",
      packageFileName: 'p'
    })
    await updater.getLinuxPackageInstallInstructions()
    await updater.showLinuxPackage()
    await updater.showLinuxPackage()

    const recovery = {
      kind: 'linux-package-install',
      packageType: 'deb',
      reason: 'manual-install-required',
      version: '1.0.61'
    }
    expect(resolveLinuxPackageInstallInstructionsMock.mock.calls).toEqual([[recovery], [recovery]])
    expect(resolveLinuxPackageRevealTargetMock.mock.calls).toEqual([[recovery], [recovery]])
    expect(showItemInFolderMock).toHaveBeenCalledTimes(2)
  })

  it('restores recovery after a recheck resolves without a terminal event', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    send.mockClear()

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(send).toHaveBeenLastCalledWith('updater:status', MANUAL_INSTALL_STATUS)
    await expect(updater.showLinuxPackage()).resolves.toBeUndefined()
  })

  it('restores recovery after a recheck fails', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    send.mockClear()

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenLastCalledWith('updater:status', MANUAL_INSTALL_STATUS)
    await expect(updater.getLinuxPackageInstallInstructions()).resolves.toEqual({
      ok: true,
      command: "sudo apt install -- '<pkg>'",
      packageFileName: 'p'
    })
  })

  it('restores recovery when a pinned check resolves to the current version', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    send.mockClear()

    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.51' })
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenLastCalledWith('updater:status', MANUAL_INSTALL_STATUS)
    await expect(updater.showLinuxPackage()).resolves.toBeUndefined()
  })

  it('restores recovery when resolving a pinned check fails', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    send.mockClear()

    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'not-a-release-tag' })
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenLastCalledWith('updater:status', MANUAL_INSTALL_STATUS)
    await expect(updater.getLinuxPackageInstallInstructions()).resolves.toEqual({
      ok: true,
      command: "sudo apt install -- '<pkg>'",
      packageFileName: 'p'
    })
  })

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
    // The replacement status has no recovery, so a second attempt cannot reach the artifact again.
    await expect(updater.showLinuxPackage()).rejects.toThrow(
      'No package install recovery is available.'
    )
    expect(resolveLinuxPackageRevealTargetMock).not.toHaveBeenCalled()
  })

  it('clears recovery for both actions once the package is gone', async () => {
    const { updater } = await startUpdater()
    await activateRecovery(updater)
    resolveLinuxPackageRevealTargetMock.mockResolvedValue({ ok: false, reason: 'missing' })

    await expect(updater.showLinuxPackage()).rejects.toThrow('no longer in the update cache')

    await expect(updater.getLinuxPackageInstallInstructions()).rejects.toThrow(
      'No package install recovery is available.'
    )
  })

  it.each(['no-sudo', 'no-package-manager'] as const)(
    'resolves %s as a result and keeps the card usable instead of rejecting',
    async (reason) => {
      const { send, updater } = await startUpdater()
      await activateRecovery(updater)
      resolveLinuxPackageInstallInstructionsMock.mockResolvedValue({ ok: false, reason })
      const statusesBefore = errorStatuses(send).length

      // Why: the renderer demotes copy on a rejection, so a missing package manager must not reject.
      await expect(updater.getLinuxPackageInstallInstructions()).resolves.toEqual({
        ok: false,
        reason,
        message: expect.stringContaining('Show the package')
      })

      expect(clearTrackedLinuxPackageArtifactMock).not.toHaveBeenCalled()
      expect(errorStatuses(send)).toHaveLength(statusesBefore)
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_recovery_unavailable',
        { reason, packageType: 'deb', version: '1.0.61' },
        expect.objectContaining({ level: 'warn' })
      )
      // Show Package must remain reachable as the promoted action.
      await expect(updater.showLinuxPackage()).resolves.toBeUndefined()
    }
  )

  it('keeps recovery available after a transient read failure', async () => {
    const { send, updater } = await startUpdater()
    await activateRecovery(updater)
    showItemInFolderMock.mockImplementationOnce(() => {
      throw new Error('no file manager available')
    })
    const statusesBefore = errorStatuses(send).length

    await expect(updater.showLinuxPackage()).rejects.toThrow(
      'could not read the downloaded package'
    )

    // Why: a read error is not evidence the artifact is bad, so retrying must stay possible.
    expect(clearTrackedLinuxPackageArtifactMock).not.toHaveBeenCalled()
    expect(errorStatuses(send)).toHaveLength(statusesBefore)
    await expect(updater.showLinuxPackage()).resolves.toBeUndefined()
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
    // A 160 MB hash outlives the cycle it started in; a newer download takes over meanwhile.
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
