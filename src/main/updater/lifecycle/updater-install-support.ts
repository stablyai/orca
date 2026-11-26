import { hasInProcessTerminalSessions } from '../../ipc/pty/provider/kill-all'
import { prepareRendererForUpdate } from '../../window/renderer-relays/native-unload-coordinator'
import { wslMoveInstallHold } from './updater-wsl-move-install-hold'
import { app } from 'electron'
import { updaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from '../../../shared/updater/updater-windows-signature-check'
import { redactLinuxPackageInstallText } from '../linux-package/linux-package-install-diagnostic'
import { getTrackedLinuxPackageArtifact } from '../linux-package/linux-package-update-recovery'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { disarmUpdateInstallExitWatchdog } from '../update-install-exit-watchdog'
import { resetMacInstallState } from '../mac-install/updater-mac-install'
import type {
  LinuxPackageInstallRecovery,
  UpdateStatus
} from '../../../shared/updater/update-status-types'
import { compareVersions } from '../releases/updater-fallback'
import {
  AUTO_UPDATE_RETRY_INTERVAL_MS,
  PRE_QUIT_CLEANUP_TIMEOUT_MS,
  REQUIRED_PRE_QUIT_CLEANUP_TIMEOUT_MS,
  type UpdateInstallTrigger
} from './updater-state'
import { UpdaterCheckState } from './updater-check-state'
import { releaseServeSupervisorPark } from './serve-supervisor-install-park'
import {
  managesUpdates,
  teamAllowsUpdate,
  type TeamUpdatePolicy
} from '../releases/updater-release-policy'

export abstract class UpdaterInstallSupport extends UpdaterCheckState {
  protected configureTeamReleaseChannel(
    team: TeamUpdatePolicy | undefined,
    includePrerelease: boolean
  ): void {
    const managed = Boolean(team?.updateChannel || team?.minimumVersion || team?.forceUpdates)
    if (managed || this.teamControlledPrerelease) {
      this.getAutoUpdater().allowPrerelease = includePrerelease
      this.teamControlledPrerelease = managed
    }
  }

  protected pinTeamApprovedReleaseFeed(
    url: string,
    policy: TeamUpdatePolicy | undefined,
    tags: readonly string[]
  ): void {
    this.teamUpdateApproval = { policy, tags }
    this.getAutoUpdater().setFeedURL({ provider: 'generic', url })
  }

  protected allowsCurrentTeamUpdate(version: string): boolean {
    return teamAllowsUpdate(
      this.getTeamUpdatePolicy?.(),
      this.teamUpdateApproval,
      version,
      this.activeUpdateSource === 'release' && !this.isPinnedBuildActive
    )
  }

  protected holdUpdateForTeamPolicy(version: string, scheduleRetry = true): boolean {
    if (this.allowsCurrentTeamUpdate(version)) {
      return false
    }
    if (this.autoUpdater) {
      this.autoUpdater.autoInstallOnAppQuit = false
    }
    this.finishActiveUpdateCheckAttempt()
    this.clearBackgroundCheckLaunchPending()
    this.clearAvailableUpdateContext()
    this.restoreReleaseUpdateSource()
    this.sendStatus({ state: 'error', ...updaterCodedMessage('teamUpdatePolicy') })
    if (scheduleRetry) {
      this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    }
    return true
  }

  protected shouldDeferTeamMacStaging(): boolean {
    return process.platform === 'darwin' && managesUpdates(this.getTeamUpdatePolicy?.())
  }

  protected shouldAcceptDownloadedUpdate(version: string, obsolete: boolean): boolean {
    // MacUpdater reads this flag after it emits update-downloaded, before handing the ZIP to Squirrel.
    if (this.autoUpdater && this.shouldDeferTeamMacStaging()) {
      this.macTeamDownloadDeferred = true
      this.autoUpdater.autoInstallOnAppQuit = false
    }
    return !obsolete && !this.holdUpdateForTeamPolicy(version)
  }

  protected getKnownReleaseUrl(): string | undefined {
    return this.availableReleaseUrl ?? undefined
  }

  protected hasInstallableDownloadedVersion(): boolean {
    return (
      this.availableVersion !== null &&
      // Local and pinned builds may intentionally downgrade.
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

  protected canProceedWithInstall(version: string, trigger: UpdateInstallTrigger): boolean {
    if (
      this.holdUpdateForTeamPolicy(version) ||
      (trigger === 'team-policy' && !this.isRequiredTeamUpdate(version))
    ) {
      this.resetQuitForUpdateState()
      this.sendToMainWindow('updater:quitAndInstallAborted')
      return false
    }
    const automatic = trigger === 'automatic'
    if (automatic && this.getAutomaticUpdates?.() !== true) {
      this.cancelAutomaticInstall(version)
      return false
    }

    const wslHold = wslMoveInstallHold()
    const hold = wslHold
      ? { message: wslHold.message }
      : automatic && hasInProcessTerminalSessions()
        ? { ...updaterCodedMessage('automaticInstallTerminalBusy'), retryable: false }
        : null
    if (!hold) {
      return true
    }

    if (wslHold) {
      recordUpdaterLifecycle(wslHold.lifecycleEvent, { version: version || null })
    }
    this.resetQuitForUpdateState()
    this.sendToMainWindow('updater:quitAndInstallAborted')
    this.sendInstallFailureStatus({
      state: 'error',
      version,
      retryAction: 'install',
      ...hold
    })
    return false
  }

  protected abstract isRequiredTeamUpdate(version: string): boolean

  protected async prepareAutomaticInstall(version: string): Promise<boolean> {
    const window = this.getMainWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      this.cancelAutomaticInstallPreparation = await prepareRendererForUpdate(window.webContents)
      if (!this.cancelAutomaticInstallPreparation) {
        this.resetQuitForUpdateState()
        this.sendInstallFailureStatus({
          state: 'error',
          version,
          retryAction: 'install',
          ...(this.canInstallOnNormalQuit(version) ? { installOnQuit: true } : {}),
          ...updaterCodedMessage('automaticInstallCheckpointFailed')
        })
        return false
      }
    }
    return true
  }

  protected cancelAutomaticInstall(version: string): void {
    this.resetQuitForUpdateState()
    this.sendStatus({ state: 'downloaded', version }, { force: true })
  }

  protected resetQuitForUpdateState(): void {
    this.cancelAutomaticInstallPreparation?.()
    this.cancelAutomaticInstallPreparation = null
    this.quitAndInstallInProgress = false
    this.quittingForUpdate = false
    this.updateInstallCommitted = false
    this.quitAndInstallNativeInvoked = false
    this.clearMacDeferredStagingTimer()
    disarmUpdateInstallExitWatchdog()
    resetMacInstallState()
    void releaseServeSupervisorPark()
  }

  protected clearMacDeferredStagingTimer(): void {
    if (this.macDeferredStagingTimer) {
      clearTimeout(this.macDeferredStagingTimer)
      this.macDeferredStagingTimer = null
    }
  }

  /** macOS quitting re-stages a Squirrel-rejected update; elsewhere restart is not known to help. */
  protected getPreCommitInstallFailureMessage(): string {
    return process.platform === 'darwin'
      ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      : 'Could not start the update installer. Orca remains open.'
  }

  /** Force repeated failures through the preload abort relay or identical retries leave the renderer stuck at its restart checkpoint. */
  protected sendInstallFailureStatus(status: UpdateStatus): void {
    this.sendStatus(status.state === 'error' ? { ...status, failurePhase: 'install' } : status, {
      force: true
    })
  }

  /** Preserve the native failure cause, including Linux manual-install instructions, for local and remote clients. */
  protected withInstallFailureCause(baseMessage: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    // Sanitize even without a tracked artifact so home paths, usernames and terminal escapes cannot leak into recovery cards.
    const redacted =
      redactLinuxPackageInstallText(raw, getTrackedLinuxPackageArtifact()?.path ?? null) ?? ''
    const cause = redacted.slice(0, this.installFailureCauseMaxLength)
    if (!cause || cause === 'Unknown error') {
      return baseMessage
    }
    // UpdateCard routes on this text; signature verdicts must not carry contradictory restart advice.
    if (
      isWindowsSignatureCheckUnavailableFailure(cause) ||
      isWindowsSignatureMismatchFailure(cause)
    ) {
      return cause
    }
    return `${baseMessage} (${cause})`
  }

  protected isQuitAndInstallHandoffActive(): boolean {
    return this.quitAndInstallInProgress
  }

  protected async runBeforeUpdateQuitCleanup(): Promise<void> {
    if (!this.onBeforeQuitCleanup) {
      return
    }

    const timeoutMs =
      this.onBeforeQuitFailure === 'abort'
        ? REQUIRED_PRE_QUIT_CLEANUP_TIMEOUT_MS
        : PRE_QUIT_CLEANUP_TIMEOUT_MS
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = Promise.resolve()
      .then(() => this.onBeforeQuitCleanup?.())
      .catch((error) => {
        recordUpdaterLifecycle(
          'pre_quit_cleanup_failed',
          { errorType: error instanceof Error ? error.name : typeof error },
          {
            level: 'warn',
            message:
              this.onBeforeQuitFailure === 'abort'
                ? 'Pre-quit cleanup failed; aborting update install'
                : 'Pre-quit cleanup failed; continuing update install'
          }
        )
        if (this.onBeforeQuitFailure === 'abort') {
          throw error
        }
      })
    const timeoutResult = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      const result = await Promise.race([cleanup.then(() => 'done' as const), timeoutResult])
      if (result === 'timeout') {
        recordUpdaterLifecycle(
          'pre_quit_cleanup_timeout',
          { timeoutMs },
          {
            level: 'warn',
            message:
              this.onBeforeQuitFailure === 'abort'
                ? `Pre-quit cleanup exceeded ${timeoutMs}ms; aborting update install`
                : `Pre-quit cleanup exceeded ${timeoutMs}ms; continuing update install`
          }
        )
        if (this.onBeforeQuitFailure === 'abort') {
          throw new Error(`Pre-quit cleanup exceeded ${timeoutMs}ms before update install`)
        }
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  protected abstract getActiveLinuxPackageRecovery(): LinuxPackageInstallRecovery | null
}
