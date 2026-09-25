import { BrowserWindow } from 'electron'
import { killAllPty } from '../ipc/pty'
import { withUpdaterSpan } from '../observability/instrumentation'
import { runWithLaunchPath } from '../startup/hydrate-shell-path'
import { markMacQuitAndInstallInFlight, isMacInstallerReady } from '../updater-mac-install'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { getLinuxPackageType } from '../linux-update-package-type'
import { LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE } from '../linux-package-downloaded-status'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  describeConflictingAppInstances,
  findConflictingAppInstancePids
} from '../updater-conflicting-app-instances'
import { requestServeUpdateHandoff, failServeUpdateHandoff } from '../serve-update-handoff'
import { UpdaterPackageRecovery } from './updater-package-recovery'

export abstract class UpdaterInstallExecution extends UpdaterPackageRecovery {
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
    // Why the flag is claimed before the await: the conflict scan is the first
    // asynchronous step in this method, and a duplicate install request landing
    // inside that window would otherwise pass the in-progress check above and
    // run a second handoff.
    this.quitAndInstallInProgress = true

    // Why here, before any other install state is set: Squirrel.Mac waits for
    // every running instance of this bundle to exit and aborts if one appears
    // mid-install, so quitting into a doomed handoff strands the user on the
    // old version with no window and no explanation.
    //
    // Why this is caught even though the probe fails open internally and cannot
    // currently throw: it runs OUTSIDE the span's catch below, and the claim
    // above is held across its await. A rejection would both escape as an
    // unhandled rejection and latch the claim, so every later install would
    // return `quit_and_install_ignored` with no card and no recovery short of
    // relaunching — the same silent wedge this guard exists to remove, reached
    // from the other side. Proceeding is the probe's own contract: an
    // unavailable scan must never block an install.
    let conflictingInstancePids: number[] = []
    try {
      conflictingInstancePids = await findConflictingAppInstancePids()
    } catch (error) {
      recordUpdaterLifecycle(
        'quit_and_install_conflict_scan_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        { level: 'warn', message: 'Could not check for other running app instances' }
      )
    }
    if (conflictingInstancePids.length > 0) {
      // Nothing else has been armed yet, so releasing the claim is the whole rollback.
      this.quitAndInstallInProgress = false
      recordUpdaterLifecycle(
        'quit_and_install_blocked_by_other_instances',
        { version: pendingVersion || null, instanceCount: conflictingInstancePids.length },
        { level: 'warn', message: 'Other running app instances would abort the macOS install' }
      )
      // The preload prepares renderer state before invoking; release it when main refuses.
      this.mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        message: describeConflictingAppInstances(conflictingInstancePids),
        // Why false when the update IS still installable: the card only promotes
        // `message` to its summary line for a non-retryable error, and otherwise
        // buries it behind "Show details" under a generic "Could not complete the
        // update." — so `true` would hide the one sentence that tells the user
        // which copies to quit. The action it costs us re-downloads a release
        // that is already staged, which is not the retry this error needs;
        // "Download Manually" still renders from `releaseUrl`.
        retryable: false,
        ...(pendingVersion ? { version: pendingVersion } : {})
      })
      return
    }

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
