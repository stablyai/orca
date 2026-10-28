import { releaseSessionsForInstaller } from './updater-installer-session-release'
import { withUpdaterSpan } from '../observability/instrumentation'
import { runWithLaunchPath } from '../startup/hydrate-shell-path'
import {
  markMacQuitAndInstallInFlight,
  isMacInstallerReady,
  setMacInstallPreflightInProgress
} from '../updater-mac-install'
import { getMacUpdateRunningInstances } from '../macos-update-running-instances'
import { commitServeSupervisorPark } from './serve-supervisor-install-park'
import { armUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { getLinuxPackageType } from '../linux-update-package-type'
import { LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE } from '../linux-package-downloaded-status'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { requestServeUpdateHandoff, failServeUpdateHandoff } from '../serve-update-handoff'
import { UpdaterMacInstallPreflight } from './updater-mac-install-preflight'
import { prepareThisProcessShipItStaging } from './shipit-leftover-recovery'
import { MAC_DEFERRED_STAGING_TIMEOUT_MS } from './updater-state'
import { isAnyWslMoveRunning } from '../persistence/moving-wsl-projects/wsl-move-running-moves'

export const WSL_MOVE_INSTALL_HELD_MESSAGE =
  'A project is moving to its WSL host. Install the update once the move finishes.'

export abstract class UpdaterInstallExecution extends UpdaterMacInstallPreflight {
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
      this.sendToMainWindow('updater:quitAndInstallAborted')
      return
    }
    if (linuxPackageType === 'unusable') {
      recordUpdaterLifecycle(
        'linux_package_marker_unusable',
        { version: pendingVersion || null },
        { level: 'warn', message: 'Linux package marker is unusable; native install blocked' }
      )
      // The preload prepares renderer state before invoking; release it when the marker is unknown.
      this.sendToMainWindow('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        message: LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE,
        ...(pendingVersion ? { version: pendingVersion } : {})
      })
      return
    }
    if (isAnyWslMoveRunning()) {
      // Quitting would interrupt the move; it recovers, but the projects stay read-only until then.
      recordUpdaterLifecycle('quit_and_install_held_for_wsl_move', {
        version: pendingVersion || null
      })
      this.sendToMainWindow('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        message: WSL_MOVE_INSTALL_HELD_MESSAGE,
        retryAction: 'install',
        ...(pendingVersion ? { version: pendingVersion } : {})
      })
      return
    }
    this.finishActiveUpdateCheckAttempt()
    this.clearBackgroundCheckLaunchPending()
    this.quitAndInstallInProgress = true

    // Block activate before any work so the old bundle cannot reopen during ShipIt replacement.
    this.quittingForUpdate = true

    try {
      this.sendStatus(
        { state: 'downloaded', version: pendingVersion, installing: true },
        { force: true }
      )
      if (!(await this.preflightMacInstall(pendingVersion))) {
        return
      }
      markMacQuitAndInstallInFlight()
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
          // Mark the span failed; returning alone would trace an aborted handoff as success.
          span.fail('Could not persist the supervised serve update handoff')
          return
        }

        await commitServeSupervisorPark(() => getMacUpdateRunningInstances())
        // Deferred staging begins inside the native install call below.
        await (this.isMacStagingDeferredToInstall() ? prepareThisProcessShipItStaging() : null)
        recordUpdaterLifecycle('quit_and_install_invoking_native', {
          version: pendingVersion || null
        })
        // Recovery may have cleared the handoff; never invoke installation afterward.
        if (!this.quitAndInstallInProgress) {
          return
        }
        // Mark before native invoke so synchronous errors can recover; pre-native errors cannot.
        setMacInstallPreflightInProgress(false)
        this.quitAndInstallNativeInvoked = true
        // Invoke before destroying PTYs/close guards so synchronous failure leaves the app usable.
        const supervisorOwnsRelaunch = this.updateInstallMode === 'supervised-headless-serve'
        runWithLaunchPath(() =>
          this.getAutoUpdater().quitAndInstall(supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
        )
        span.addEvent('native_quit_and_install_invoked')

        // Synchronous error dispatch may already have cleared the handoff; skip destructive prep.
        if (!this.quitAndInstallInProgress) {
          // Recovery set currentStatus; mark the span failed rather than return traced success.
          span.fail(
            this.currentStatus.state === 'error'
              ? this.currentStatus.message
              : 'quitAndInstall returned without invoking the installer'
          )
          return
        }

        // Deferred Squirrel staging outlives quitAndInstall; keep the server intact until staging succeeds.
        if (this.isMacStagingDeferredToInstall() && !isMacInstallerReady()) {
          // MacUpdater's retained completion listener can install late; report timeout without abandoning the live handoff.
          this.macDeferredStagingTimer = setTimeout(() => {
            this.macDeferredStagingTimer = null
            recordUpdaterLifecycle(
              'macos_deferred_staging_slow',
              { timeoutMs: MAC_DEFERRED_STAGING_TIMEOUT_MS },
              { level: 'warn', message: 'Squirrel has not staged the supervised serve update' }
            )
            this.sendInstallFailureStatus({
              state: 'error',
              message:
                'macOS has not finished preparing the update. Orca keeps serving and installs it once ready; restart the Orca service if it never does.',
              ...(pendingVersion ? { version: pendingVersion } : {}),
              retryable: false
            })
          }, MAC_DEFERRED_STAGING_TIMEOUT_MS)
          span.addEvent('awaiting_squirrel_staging')
          return
        }

        const windowCount = releaseSessionsForInstaller()
        span.addEvent('local_pty_kill_all')
        span.addEvent('window_close_listeners_removed', { windowCount })

        // Keep activate blocked after commit; unstaged macOS installs remain recoverable on late native errors.
        if (process.platform !== 'darwin' || isMacInstallerReady()) {
          this.commitInFlightInstall()
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

  // Supervised serve disables autoInstallOnAppQuit; MacUpdater only stages inside quitAndInstall, so waiting first deadlocks.
  protected isMacStagingDeferredToInstall(): boolean {
    return process.platform === 'darwin' && this.updateInstallMode === 'supervised-headless-serve'
  }

  protected isAwaitingMacStaging(): boolean {
    return (
      this.isMacStagingDeferredToInstall() &&
      this.quitAndInstallInProgress &&
      this.quitAndInstallNativeInvoked &&
      !this.updateInstallCommitted
    )
  }

  /** Squirrel staged the bundle that quitAndInstall asked for; the installer now owns the swap. */
  protected commitStagedMacInstall(): void {
    if (!this.isAwaitingMacStaging()) {
      return
    }
    this.clearMacDeferredStagingTimer()
    // Commit before fallible cleanup inside Squirrel's event so the watchdog and native quit listener still run.
    this.commitInFlightInstall()
    recordUpdaterLifecycle('macos_deferred_staging_committed', {
      version: this.getPendingInstallVersion() || null
    })
    try {
      releaseSessionsForInstaller()
    } catch (error) {
      recordUpdaterLifecycle(
        'post_commit_cleanup_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        {
          level: 'warn',
          message: 'Update install cleanup failed after commit; install already applied'
        }
      )
    }
  }

  // Only Squirrel errors end staging; unrelated background-check errors must leave it active.
  protected failMacStaging(error: unknown): void {
    if (this.isAwaitingMacStaging()) {
      this.handleQuitAndInstallFailure(error)
    }
  }

  protected commitInFlightInstall(): void {
    if (!this.quitAndInstallInProgress || this.updateInstallCommitted) {
      return
    }
    this.updateInstallCommitted = true
    // After commit, wedged shutdown strands the installer waiting for this process (#4438); arm an exit watchdog.
    armUpdateInstallExitWatchdog()
  }

  // Recover only between native invoke and commit; clearing quittingForUpdate afterward could reopen the old bundle mid-install.
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
