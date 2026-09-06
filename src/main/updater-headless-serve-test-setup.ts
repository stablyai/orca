import { createHash } from 'node:crypto'
import { vi } from 'vitest'

export const SHA512 = createHash('sha512').update('appimage-content').digest('base64')
export const SERVE_UPDATE_VERDICT_POLL_MS = 500

export function setupHeadlessServeTestHarness() {
  const {
    appMock,
    autoUpdaterMock,
    nativeUpdaterMock,
    killAllPtyMock,
    recordUpdaterLifecycleMock,
    requestServeUpdateHandoffMock,
    failServeUpdateHandoffMock,
    hasServeUpdateSupervisorMock,
    writeUpdateRequestMock,
    clearUpdateRequestMock,
    clearUpdateResultMock,
    readServeUpdateResultForMock,
    writeServeUpdateCensusContinuationMock,
    clearServeUpdateCensusContinuationMock,
    captureServeUpdateAppImageMock,
    runProcessMock,
    resetHandlers
  } = vi.hoisted(() => {
    const appHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const updaterHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const emit = (
      handlers: Map<string, ((...args: unknown[]) => void)[]>,
      event: string,
      ...args: unknown[]
    ): void => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const appMock = {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        appHandlers.set(event, [...(appHandlers.get(event) ?? []), handler])
        return appMock
      }),
      emit: (event: string, ...args: unknown[]) => emit(appHandlers, event, ...args),
      quit: vi.fn()
    }

    const autoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      checkForUpdates: vi.fn().mockResolvedValue(null),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        updaterHandlers.set(event, [...(updaterHandlers.get(event) ?? []), handler])
        return autoUpdaterMock
      }),
      emit: (event: string, ...args: unknown[]) => emit(updaterHandlers, event, ...args)
    }

    return {
      appMock,
      autoUpdaterMock,
      nativeUpdaterMock: { on: vi.fn() },
      killAllPtyMock: vi.fn(),
      recordUpdaterLifecycleMock: vi.fn(),
      requestServeUpdateHandoffMock: vi.fn(() => true),
      failServeUpdateHandoffMock: vi.fn(),
      hasServeUpdateSupervisorMock: vi.fn(() => true),
      writeUpdateRequestMock: vi.fn(() => true),
      clearUpdateRequestMock: vi.fn(),
      writeServeUpdateCensusContinuationMock: vi.fn(() => true),
      clearServeUpdateCensusContinuationMock: vi.fn(),
      clearUpdateResultMock: vi.fn(),
      readServeUpdateResultForMock: vi.fn(),
      captureServeUpdateAppImageMock: vi.fn(),
      runProcessMock: vi.fn(() =>
        Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false })
      ),
      resetHandlers: () => {
        appHandlers.clear()
        updaterHandlers.clear()
      }
    }
  })

  vi.mock('electron', () => ({
    app: appMock,
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    autoUpdater: nativeUpdaterMock,
    powerMonitor: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
    net: { fetch: vi.fn() }
  }))

  vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
  vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }))
  vi.mock('./linux-update-package-type', () => ({
    getLinuxPackageType: () => 'non-root',
    getLinuxRootPackageType: () => null,
    isExternallyManagedLinuxInstall: () => false
  }))
  vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
  vi.mock('./ipc/pty', () => ({ killAllPty: killAllPtyMock }))
  vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
  vi.mock('./updater-nudge', () => ({
    fetchNudge: vi.fn().mockResolvedValue(null),
    shouldApplyNudge: vi.fn().mockReturnValue(false)
  }))
  vi.mock('./updater-prerelease-feed', () => ({
    fetchNewerReleaseTagsWithReadiness: vi.fn().mockResolvedValue({
      tags: ['v1.0.61'],
      state: 'ready'
    }),
    getReleaseDownloadUrl: vi.fn()
  }))
  vi.mock('./update-install-exit-watchdog', () => ({
    armUpdateInstallExitWatchdog: vi.fn(),
    disarmUpdateInstallExitWatchdog: vi.fn()
  }))
  vi.mock('./updater-lifecycle-diagnostics', () => ({
    recordUpdaterLifecycle: recordUpdaterLifecycleMock
  }))
  vi.mock('./serve-update-handoff', () => ({
    failServeUpdateHandoff: failServeUpdateHandoffMock,
    getServeUpdateHandoffFailure: vi.fn(() => null),
    hasServeUpdateSupervisor: hasServeUpdateSupervisorMock,
    requestServeUpdateHandoff: requestServeUpdateHandoffMock
  }))
  vi.mock('./serve-update-spool', () => ({
    writeUpdateRequest: writeUpdateRequestMock,
    clearUpdateRequest: clearUpdateRequestMock,
    clearUpdateResult: clearUpdateResultMock,
    readServeUpdateResultFor: readServeUpdateResultForMock,
    writeServeUpdateCensusContinuation: writeServeUpdateCensusContinuationMock,
    clearServeUpdateCensusContinuation: clearServeUpdateCensusContinuationMock,
    getServeUpdateAttemptId: vi.fn(() => 'attempt-42'),
    getServeUpdateUnitName: vi.fn(() => 'orca-serve.service')
  }))
  vi.mock('./serve-update-artifact-capture', () => ({
    captureServeUpdateAppImage: captureServeUpdateAppImageMock
  }))
  vi.mock('./cli/serve-update-helper-installer', () => ({
    SERVE_UPDATE_HELPER_INSTALL_PATH: '/usr/lib/orca/serve-update-helper.sh'
  }))
  vi.mock('./linux-package-install-command', () => ({
    resolveTrustedExecutable: vi.fn(() => '/usr/bin/sudo')
  }))
  vi.mock('../shared/child-process/run-process', () => ({
    runProcess: runProcessMock
  }))

  return {
    appMock,
    autoUpdaterMock,
    nativeUpdaterMock,
    killAllPtyMock,
    recordUpdaterLifecycleMock,
    requestServeUpdateHandoffMock,
    failServeUpdateHandoffMock,
    hasServeUpdateSupervisorMock,
    writeUpdateRequestMock,
    clearUpdateRequestMock,
    clearUpdateResultMock,
    readServeUpdateResultForMock,
    writeServeUpdateCensusContinuationMock,
    clearServeUpdateCensusContinuationMock,
    captureServeUpdateAppImageMock,
    runProcessMock,
    resetHandlers
  }
}

/** Shared beforeEach: reset every harness mock the handoff tests touch. */
export function resetHeadlessServeHarness(
  harness: ReturnType<typeof setupHeadlessServeTestHarness>
) {
  vi.resetModules()
  vi.useFakeTimers()
  const { autoUpdaterMock, nativeUpdaterMock, appMock } = harness
  autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
  autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue([])
  autoUpdaterMock.quitAndInstall.mockReset()
  autoUpdaterMock.setFeedURL.mockReset()
  autoUpdaterMock.on.mockClear()
  autoUpdaterMock.autoInstallOnAppQuit = false
  autoUpdaterMock.autoRunAppAfterInstall = true
  nativeUpdaterMock.on.mockReset()
  appMock.on.mockClear()
  appMock.quit.mockReset()
  harness.killAllPtyMock.mockReset()
  harness.recordUpdaterLifecycleMock.mockReset()
  harness.writeUpdateRequestMock.mockReset().mockReturnValue(true)
  harness.clearUpdateRequestMock.mockReset()
  harness.clearUpdateResultMock.mockReset()
  harness.requestServeUpdateHandoffMock.mockReset().mockReturnValue(true)
  harness.failServeUpdateHandoffMock.mockReset()
  harness.hasServeUpdateSupervisorMock.mockReset().mockReturnValue(true)
  harness.readServeUpdateResultForMock.mockReset()
  harness.readServeUpdateResultForMock.mockReturnValue(null)
  harness.writeServeUpdateCensusContinuationMock.mockReset().mockReturnValue(true)
  harness.clearServeUpdateCensusContinuationMock.mockReset()
  harness.captureServeUpdateAppImageMock.mockReset()
  harness.captureServeUpdateAppImageMock.mockResolvedValue({ ok: true, artifact: null })
  harness.runProcessMock
    .mockReset()
    .mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
  harness.resetHandlers()
}
