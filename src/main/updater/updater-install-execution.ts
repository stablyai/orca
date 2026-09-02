import { BrowserWindow } from 'electron'
import { killAllPty } from '../ipc/pty'
import { withUpdaterSpan } from '../observability/instrumentation'
import { runWithLaunchPath } from '../startup/hydrate-shell-path'
import { markMacQuitAndInstallInFlight, isMacInstallerReady } from '../updater-mac-install'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { getLinuxRootPackageType } from '../linux-update-package-type'
import {
  beginLinuxPackageInstallDiagnosticCapture,
  endLinuxPackageInstallDiagnosticCapture
} from '../linux-package-install-diagnostic'
import { getTrackedLinuxPackageArtifact } from '../linux-package-update-recovery'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { requestServeUpdateHandoff, failServeUpdateHandoff } from '../serve-update-handoff'
import { UpdaterPackageRecovery } from './updater-package-recovery'

export abstract class UpdaterInstallExecution extends UpdaterPackageRecovery {
  protected async performQuitAndInstall(): Promise<void> {
    if (this.quitAndInstallInProgress || this.linuxPackageRevalidationInFlight) {
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
    // Why: the retained .deb/.rpm sits on a user-writable path that a root package manager is about
    // to read, and nothing re-checks it after download. Re-prove it here — before any teardown — so a
    // swapped or vanished package aborts instead of being installed as root. The synchronous guard
    // keeps every non-Linux install on its existing timing.
    if (
      getTrackedLinuxPackageArtifact() &&
      !(await this.proveRetainedLinuxPackage(pendingVersion))
    ) {
      // Why: the renderer armed its restart before invoking, and it infers the abort from the error
      // status — which a stale-cycle verdict deliberately withholds. Signal the abandon here, where
      // it cannot depend on that decision, or the window keeps skipping its unsaved-work prompt.
      this.mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
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
        // Why: invoke before killAllPty/removing close listeners so a sync 'error' (the "no filepath" path) can recover while windows and PTYs are intact.
        const supervisorOwnsRelaunch = this.updateInstallMode === 'supervised-headless-serve'
        // Why: BaseUpdater logs child stderr but drops it from the 'error' event, so retain it for the span of this call.
        beginLinuxPackageInstallDiagnosticCapture(getTrackedLinuxPackageArtifact()?.path ?? null)
        try {
          runWithLaunchPath(() =>
            this.getAutoUpdater().quitAndInstall(supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
          )
        } finally {
          const diagnostic = endLinuxPackageInstallDiagnosticCapture()
          // Why: a synchronous 'error' already consumed and reset this attempt; re-stashing would leak it into the next one.
          this.lastInstallAttemptDiagnostic = this.quitAndInstallInProgress ? diagnostic : null
        }
        span.addEvent('native_quit_and_install_invoked')

        // Why: quitAndInstall can synchronously clear quitAndInstallInProgress via recovery (Win/Linux dispatchError); skip destructive prep if it already ran.
        if (!this.quitAndInstallInProgress) {
          // Why: recovery already wrote the reason to currentStatus; a bare return would exit this span Success.
          span.fail(
            this.currentStatus.state === 'error'
              ? this.currentStatus.message
              : 'quitAndInstall returned without invoking the installer'
          )
          return
        }

        // Why: DebUpdater/RpmUpdater install through spawnSync, so a normal return already means the
        // package is installed. Commit here or a throw in the cleanup below is reported as an install
        // failure — offering a recovery card, and stale stderr, for an update that actually succeeded.
        if (getLinuxRootPackageType() !== null) {
          this.updateInstallCommitted = true
          armUpdateInstallExitWatchdog()
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
      // Why: on Linux the package is already installed once quitAndInstall returns, and the installer is
      // waiting for this process to exit. Tearing down here would disarm the exit watchdog (#4438), clear
      // quittingForUpdate mid-quit, and tell the user an install failed that actually succeeded.
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
      // Why: a pre-native cleanup/tracing exception is not a package install failure and must not be labelled as one.
      const quitAndInstallNativeInvokedBeforeReset = this.quitAndInstallNativeInvoked
      const recoveryStatus =
        quitAndInstallNativeInvokedBeforeReset && !this.updateInstallCommitted
          ? this.buildLinuxPackageInstallFailureStatus(error)
          : null
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
      this.sendInstallFailureStatus(
        recoveryStatus ?? {
          state: 'error',
          // Why: past the native invoke this is the same pre-commit failure the event path reports, so it gets the same copy; only a pre-native exception can be helped by a restart.
          // A synchronous throw out of quitAndInstall carries the same installer text the 'error' event would have.
          message: quitAndInstallNativeInvokedBeforeReset
            ? this.withInstallFailureCause(this.getPreCommitInstallFailureMessage(), error)
            : 'Could not restart to install the update. Quit and reopen Orca, then try again.'
        }
      )
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
    const recoveryStatus = this.buildLinuxPackageInstallFailureStatus(error)
    failServeUpdateHandoff('The native updater rejected the install request.')
    this.resetQuitForUpdateState()
    // Durable data carries classification only — the cause text stays on the status the user can read.
    recordUpdaterLifecycle(
      'quit_and_install_failed_via_event',
      { errorType: error instanceof Error ? error.name : typeof error },
      {
        level: 'warn',
        message: 'Update install could not start; recovered app state'
      }
    )
    this.sendInstallFailureStatus(
      recoveryStatus ?? {
        state: 'error',
        message: this.withInstallFailureCause(this.getPreCommitInstallFailureMessage(), error)
      }
    )
    return true
  }
}
