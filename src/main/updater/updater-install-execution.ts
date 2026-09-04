import { app, BrowserWindow } from 'electron'
import { killAllPty } from '../ipc/pty'
import { withUpdaterSpan } from '../observability/instrumentation'
import { runWithLaunchPath } from '../startup/hydrate-shell-path'
import { markMacQuitAndInstallInFlight, isMacInstallerReady } from '../updater-mac-install'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { getLinuxPackageType } from '../linux-update-package-type'
import { LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE } from '../linux-package-downloaded-status'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { requestServeUpdateHandoff, failServeUpdateHandoff } from '../serve-update-handoff'
import {
  clearUpdateRequest,
  clearUpdateResult,
  getServeUpdateUnitName,
  readServeUpdateResultFor,
  writeUpdateRequest
} from '../serve-update-spool'
import type { ServeUpdateVerdict } from '../../shared/serve-update-spool'
import { captureServeUpdateAppImage } from '../serve-update-artifact-capture'
import { UpdaterPackageRecovery } from './updater-package-recovery'

/** How long the app waits for the root helper's verdict before assuming the worst. */
const SERVE_UPDATE_VERDICT_TIMEOUT_MS = 90_000
const SERVE_UPDATE_VERDICT_POLL_MS = 500

export abstract class UpdaterInstallExecution extends UpdaterPackageRecovery {
  /** Set by serve startup; identifies the runtime across the restart the helper performs. */
  private serveUpdateRuntimeId = ''
  /** The most recent update-downloaded event, kept for the supervised serve install path. */
  private supervisedServeDownloadInfo: Record<string, unknown> | null = null

  /** Called by serve startup once the runtime id exists. */
  setServeUpdateRuntimeId(runtimeId: string): void {
    this.serveUpdateRuntimeId = runtimeId
  }

  /** Called by the update-downloaded event bridge so serve can spool the artifact later. */
  recordSupervisedServeDownloadInfo(info: unknown): void {
    if (this.updateInstallMode !== 'supervised-headless-serve') {
      return
    }
    this.supervisedServeDownloadInfo =
      info && typeof info === 'object' ? (info as Record<string, unknown>) : null
  }

  private consumeSupervisedServeDownloadInfo(): Record<string, unknown> | null {
    const info = this.supervisedServeDownloadInfo
    this.supervisedServeDownloadInfo = null
    return info
  }

  /**
   * Captures the downloaded AppImage and spools the install request for the root helper.
   * Clears BOTH spool files first so a stale verdict from a previous attempt can never be
   * mistaken for this one's. Returns the spooled target version, or null after reporting
   * the failure.
   */
  private async captureAndSpoolUpdate(pendingVersion: string): Promise<string | null> {
    clearUpdateResult()
    clearUpdateRequest()
    const downloadInfo = this.consumeSupervisedServeDownloadInfo()
    if (!downloadInfo) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: 'missing-download-metadata' },
        { level: 'warn', message: 'No verifiable AppImage download for the supervised install' }
      )
      this.sendErrorStatus('Could not verify the downloaded update. Orca remains running.', true)
      return null
    }
    const capture = await captureServeUpdateAppImage(downloadInfo)
    if (!capture.ok) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: `artifact-${capture.reason}` },
        { level: 'warn', message: 'The downloaded AppImage failed verification' }
      )
      this.sendErrorStatus('The downloaded update failed verification. Orca remains running.', true)
      return null
    }
    if (
      !writeUpdateRequest({
        runtimeId: this.serveUpdateRuntimeId,
        fromVersion: app.getVersion(),
        targetVersion: capture.artifact.targetVersion,
        artifactPath: capture.artifact.artifactPath,
        sha512: capture.artifact.sha512,
        servingPid: process.pid,
        unitName: getServeUpdateUnitName()
      })
    ) {
      recordUpdaterLifecycle(
        'headless_serve_handoff_failed',
        { version: pendingVersion || null, reason: 'spool-write-failed' },
        { level: 'warn', message: 'Could not write the serve update request' }
      )
      this.sendErrorStatus(
        'Could not hand the update to the server supervisor. Orca remains running.',
        true
      )
      return null
    }
    return capture.artifact.targetVersion
  }

  /** Resolves once the helper's verdict lands in the spool, or null on timeout. Never clears spool state. */
  private async awaitSupervisedServeVerdict(
    runtimeId: string,
    targetVersion: string
  ): Promise<{ verdict: ServeUpdateVerdict; message: string } | null> {
    const deadline = Date.now() + SERVE_UPDATE_VERDICT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const result = readServeUpdateResultFor(runtimeId, targetVersion)
      if (result) {
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, SERVE_UPDATE_VERDICT_POLL_MS))
    }
    return null
  }

  protected async performQuitAndInstall(): Promise<void> {
    if (this.quitAndInstallInProgress) {
      recordUpdaterLifecycle('quit_and_install_ignored', { reason: 'already-in-progress' })
      return
    }

    if (this.pendingQuitAndInstallTimer) {
      clearTimeout(this.pendingQuitAndInstallTimer)
      this.pendingQuitAndInstallTimer = null
    }

    const pendingVersion = this.getPendingInstallVersion()
    if (this.deferHeadlessServeInstall('install', pendingVersion)) {
      return
    }
    // Why before the deb/rpm gate: the supervised branch never reaches the native installer.
    // Linux only: darwin keeps the native handoff flow, since MacUpdater ignores quitAndInstall args anyway.
    if (process.platform === 'linux' && this.updateInstallMode === 'supervised-headless-serve') {
      this.quitAndInstallInProgress = true
      this.quittingForUpdate = true
      const targetVersion = await this.captureAndSpoolUpdate(pendingVersion)
      if (!targetVersion) {
        this.resetQuitForUpdateState()
        return
      }
      const outcome = await this.awaitSupervisedServeVerdict(
        this.serveUpdateRuntimeId,
        targetVersion
      )
      if (!outcome || outcome.verdict !== 'accepted') {
        // Why: a rejected/failed/timed-out request must not linger for the next boot's helper.
        clearUpdateRequest()
        recordUpdaterLifecycle(
          'headless_serve_update_not_accepted',
          { version: pendingVersion || null },
          { level: 'warn', message: 'The server supervisor did not accept the update' }
        )
        this.sendErrorStatus(
          outcome?.message || 'The server update did not complete. The server keeps running.',
          true
        )
        this.resetQuitForUpdateState()
        return
      }
      recordUpdaterLifecycle('headless_serve_update_accepted', {
        version: pendingVersion || null
      })
      // Why before quit: the helper needs the unit stop to look like a supervised exit, and
      // pre-quit cleanup (auth preservation) must still run while this process is alive.
      await this.runBeforeUpdateQuitCleanup()
      killAllPty()
      // Why: the helper stops the unit; systemd's RestartPreventExitStatus=3 plus a clean quit
      // keep this exit from being read as a crash. Fail-safe remains the exit watchdog.
      armUpdateInstallExitWatchdog()
      app.quit()
      return
    }
    const linuxPackageType = getLinuxPackageType()
    if (linuxPackageType === 'deb' || linuxPackageType === 'rpm') {
      recordUpdaterLifecycle('linux_package_manual_install_required', {
        packageType: linuxPackageType,
        version: pendingVersion || null
      })
      // The preload prepares renderer state before invoking; explicitly release it when main refuses.
      this.mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
      return
    }
    if (linuxPackageType === 'unusable') {
      recordUpdaterLifecycle(
        'linux_package_marker_unusable',
        { version: pendingVersion || null },
        { level: 'warn', message: 'Linux package marker is unusable; native install blocked' }
      )
      // The preload prepares renderer state before invoking; release it when the marker is unknown.
      this.mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        message: LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE,
        ...(pendingVersion ? { version: pendingVersion } : {})
      })
      return
    }
    this.quitAndInstallInProgress = true

    markMacQuitAndInstallInFlight()

    // Set BEFORE anything else so the `activate` handler doesn't reopen the old version while ShipIt replaces the .app bundle.
    this.quittingForUpdate = true

    try {
      await withUpdaterSpan({ stage: 'install' }, async (span) => {
        span.setAttribute('updater.version', pendingVersion || 'unknown')
        span.setAttribute('updater.platform', process.platform)
        span.setAttribute(
          'updater.macosInstallerReady',
          process.platform === 'darwin' ? isMacInstallerReady() : true
        )
        recordUpdaterLifecycle('quit_and_install_started', {
          version: pendingVersion || null,
          macInstallerReady: process.platform === 'darwin' ? isMacInstallerReady() : true
        })
        span.addEvent('pre_quit_cleanup_start')
        await this.runBeforeUpdateQuitCleanup()
        span.addEvent('pre_quit_cleanup_done')

        if (
          this.updateInstallMode === 'supervised-headless-serve' &&
          !requestServeUpdateHandoff(pendingVersion)
        ) {
          recordUpdaterLifecycle(
            'headless_serve_handoff_failed',
            { version: pendingVersion || null },
            {
              level: 'warn',
              message: 'Could not persist supervised serve update handoff'
            }
          )
          this.sendErrorStatus(
            'Could not prepare the supervised server restart. Orca remains running.',
            true
          )
          this.resetQuitForUpdateState()
          // Why: a bare return would exit this span Success and hide the aborted install from tracing.
          span.fail('Could not persist the supervised serve update handoff')
          return
        }

        recordUpdaterLifecycle('quit_and_install_invoking_native', {
          version: pendingVersion || null
        })
        // Why: defensive — never call quitAndInstall if recovery/reset already cleared the handoff.
        if (!this.quitAndInstallInProgress) {
          return
        }
        // Why: mark before the call so a sync 'error' during quitAndInstall can recover; pre-native errors must not look like install failure.
        this.quitAndInstallNativeInvoked = true
        // Why: invoke before killAllPty/removing close listeners so a sync 'error' can recover while windows and PTYs are intact.
        const supervisorOwnsRelaunch = this.updateInstallMode === 'supervised-headless-serve'
        runWithLaunchPath(() =>
          this.getAutoUpdater().quitAndInstall(supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
        )
        span.addEvent('native_quit_and_install_invoked')

        // Why: quitAndInstall can synchronously clear quitAndInstallInProgress via dispatchError; skip destructive prep if it already ran.
        if (!this.quitAndInstallInProgress) {
          // Why: recovery already wrote the reason to currentStatus; a bare return would exit this span Success.
          span.fail(
            this.currentStatus.state === 'error'
              ? this.currentStatus.message
              : 'quitAndInstall returned without invoking the installer'
          )
          return
        }

        killAllPty()
        span.addEvent('local_pty_kill_all')

        for (const win of BrowserWindow.getAllWindows()) {
          win.removeAllListeners('close')
        }
        span.addEvent('window_close_listeners_removed', {
          windowCount: BrowserWindow.getAllWindows().length
        })

        // Why: committed installs keep quittingForUpdate so dock activate can't reopen the old process; macOS without Squirrel stays uncommitted so late native errors can still recover.
        if (
          !this.updateInstallCommitted &&
          (process.platform !== 'darwin' || isMacInstallerReady())
        ) {
          this.updateInstallCommitted = true
          // Why: past commit the installer waits for this process to exit; a wedged async shutdown would strand the user with no app and no update (#4438).
          armUpdateInstallExitWatchdog()
        }
      })
    } catch (error) {
      // Past commit the installer is waiting for this process to exit; keep the handoff and watchdog intact.
      if (this.updateInstallCommitted) {
        recordUpdaterLifecycle(
          'post_commit_cleanup_failed',
          { errorType: error instanceof Error ? error.name : typeof error },
          {
            level: 'warn',
            message: 'Update install cleanup failed after commit; install already applied'
          }
        )
        return
      }
      const quitAndInstallNativeInvokedBeforeReset = this.quitAndInstallNativeInvoked
      failServeUpdateHandoff('Could not invoke the native updater.')
      this.resetQuitForUpdateState()
      recordUpdaterLifecycle(
        'quit_and_install_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        {
          level: 'warn',
          message: 'Could not start update install'
        }
      )
      this.sendInstallFailureStatus({
        state: 'error',
        // A synchronous throw carries the same installer text the 'error' event would have.
        message: quitAndInstallNativeInvokedBeforeReset
          ? this.withInstallFailureCause(this.getPreCommitInstallFailureMessage(), error)
          : 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      })
    }
  }

  // Why: quitAndInstall failures arrive via 'error'; recover only after native invoke and before commit, else clearing quittingForUpdate lets dock activate reopen the old process mid-installer.
  protected handleQuitAndInstallFailure(error?: unknown): boolean {
    if (
      !this.quitAndInstallInProgress ||
      !this.quitAndInstallNativeInvoked ||
      this.updateInstallCommitted
    ) {
      return false
    }
    failServeUpdateHandoff('The native updater rejected the install request.')
    this.resetQuitForUpdateState()
    recordUpdaterLifecycle(
      'quit_and_install_failed_via_event',
      { errorType: error instanceof Error ? error.name : typeof error },
      {
        level: 'warn',
        message: 'Update install could not start; recovered app state'
      }
    )
    this.sendInstallFailureStatus({
      state: 'error',
      message: this.withInstallFailureCause(this.getPreCommitInstallFailureMessage(), error)
    })
    return true
  }
}
