import { app } from 'electron'
import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from '../../shared/updater-windows-signature-check'
import { redactLinuxPackageInstallText } from '../linux-package-install-diagnostic'
import { getTrackedLinuxPackageArtifact } from '../linux-package-update-recovery'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { disarmUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { resetMacInstallState } from '../updater-mac-install'
import type { LinuxPackageInstallRecovery, UpdateStatus } from '../../shared/update-status-types'
import { compareVersions } from '../updater-fallback'
import { PRE_QUIT_CLEANUP_TIMEOUT_MS } from './updater-state'
import { UpdaterCheckState } from './updater-check-state'

export abstract class UpdaterInstallSupport extends UpdaterCheckState {
  protected getKnownReleaseUrl(): string | undefined {
    return this.availableReleaseUrl ?? undefined
  }

  protected hasInstallableDownloadedVersion(): boolean {
    return (
      this.availableVersion !== null &&
      // Why: local builds and pinned dev jumps may intentionally move backwards.
      (this.activeUpdateSource !== 'release' ||
        this.isPinnedBuildActive ||
        compareVersions(this.availableVersion, app.getVersion()) > 0)
    )
  }

  protected getPendingInstallVersion(): string {
    if (this.availableVersion) {
      return this.availableVersion
    }
    if (this.currentStatus.state === 'downloading' || this.currentStatus.state === 'downloaded') {
      return this.currentStatus.version
    }
    if (
      this.currentStatus.state === 'error' &&
      this.currentStatus.recovery?.kind === 'linux-package-install'
    ) {
      return this.currentStatus.recovery.version
    }
    return ''
  }

  protected deferHeadlessServeInstall(phase: 'download' | 'install', version: string): boolean {
    if (this.updateInstallMode !== 'unsupported-headless-serve') {
      return false
    }
    const diagnosticVersion = version || 'unknown'
    if (this.lastInstallDeferralVersion[phase] !== diagnosticVersion) {
      this.lastInstallDeferralVersion[phase] = diagnosticVersion
      recordUpdaterLifecycle(
        'headless_serve_install_deferred',
        { phase, version: version || null },
        {
          level: 'warn',
          message: 'Update install deferred while hosting orca serve'
        }
      )
    }
    this.sendErrorStatus(
      'This orca serve process was not started by an update-capable supervisor. Keep it running and update Orca through its service manager.',
      true
    )
    return true
  }

  protected getCheckFailureKey(message: string, userInitiated?: boolean): string {
    return `${userInitiated ? 'user' : 'auto'}:${message}`
  }

  protected resetQuitForUpdateState(): void {
    this.quitAndInstallInProgress = false
    this.quittingForUpdate = false
    this.updateInstallCommitted = false
    this.quitAndInstallNativeInvoked = false
    disarmUpdateInstallExitWatchdog()
    resetMacInstallState()
  }

  /**
   * On macOS a pre-commit failure means Squirrel rejected the staged update, and quitting does re-stage
   * it — so keep that advice there. Everywhere else a restart is not known to help.
   */
  protected getPreCommitInstallFailureMessage(): string {
    return process.platform === 'darwin'
      ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      : 'Could not start the update installer. Orca remains open.'
  }

  /**
   * Sends an install-failure status even when it repeats the current one. "Try Automatic Install
   * Again" usually fails identically, and a deduped status would never reach the preload abort relay,
   * leaving the renderer stuck in its restart checkpoint.
   */
  protected sendInstallFailureStatus(status: UpdateStatus): void {
    this.sendStatus(status, { force: true })
  }

  /**
   * Appends the updater's own text to the generic install-failure copy. Without it the only record of
   * why the install never started is destroyed — on Linux that text carries the exact `dpkg -i <path>`
   * command the user has to run by hand, and remote clients get nothing but "it didn't come back".
   */
  protected withInstallFailureCause(baseMessage: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    // Why: the retained-package card runs its text through this same sanitizer, so a home directory,
    // user name, or terminal escape must not reach the card merely because no artifact was tracked.
    const redacted =
      redactLinuxPackageInstallText(raw, getTrackedLinuxPackageArtifact()?.path ?? null) ?? ''
    const cause = redacted.slice(0, this.installFailureCauseMaxLength)
    if (!cause || cause === 'Unknown error') {
      return baseMessage
    }
    // Why: UpdateCard picks the whole card off this string, so a signature verdict must not be prefixed by contradictory restart advice.
    if (
      isWindowsSignatureCheckUnavailableFailure(cause) ||
      isWindowsSignatureMismatchFailure(cause)
    ) {
      return cause
    }
    return `${baseMessage} (${cause})`
  }

  /**
   * The recovery status for a failed `.deb`/`.rpm` install, or null when no retained package can
   * recover it. Must run before `resetQuitForUpdateState()` clears the attempt diagnostic.
   */
  protected isQuitAndInstallHandoffActive(): boolean {
    return this.quitAndInstallInProgress
  }

  protected async runBeforeUpdateQuitCleanup(): Promise<void> {
    if (!this.onBeforeQuitCleanup) {
      return
    }

    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = Promise.resolve()
      .then(() => this.onBeforeQuitCleanup?.())
      .catch((error) => {
        recordUpdaterLifecycle(
          'pre_quit_cleanup_failed',
          { errorType: error instanceof Error ? error.name : typeof error },
          {
            level: 'warn',
            message: 'Pre-quit cleanup failed; continuing update install'
          }
        )
      })
    const timeoutResult = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), PRE_QUIT_CLEANUP_TIMEOUT_MS)
    })

    const result = await Promise.race([cleanup.then(() => 'done' as const), timeoutResult])
    if (result === 'timeout') {
      recordUpdaterLifecycle(
        'pre_quit_cleanup_timeout',
        { timeoutMs: PRE_QUIT_CLEANUP_TIMEOUT_MS },
        {
          level: 'warn',
          message: `Pre-quit cleanup exceeded ${PRE_QUIT_CLEANUP_TIMEOUT_MS}ms; continuing update install`
        }
      )
      return
    }

    if (timeout) {
      clearTimeout(timeout)
    }
  }

  protected abstract getActiveLinuxPackageRecovery(): LinuxPackageInstallRecovery | null
}
