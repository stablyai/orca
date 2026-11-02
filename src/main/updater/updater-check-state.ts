import { writeMainThreadDiagnosticMarker } from '../diagnostics/main-thread-churn-probe'
import { isWindowsSignatureCheckUnavailableFailure } from '../../shared/updater-windows-signature-check'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { getRetainedLinuxPackageManualInstallStatus } from '../linux-package-downloaded-status'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type { UpdateCheckVariant } from './updater-types'
import { UpdaterStatus } from './updater-status'
import type { UpdaterCodedMessage } from '../../shared/updater-failure-copy'
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_RETRY_INTERVAL_MS,
  UPDATE_CHECK_SILENT_SETTLE_DELAY_MS,
  UPDATE_CHECK_STALL_TIMEOUT_MS
} from './updater-state'

export abstract class UpdaterCheckState extends UpdaterStatus {
  protected getOptionsForUpdateCheckVariant(variant: UpdateCheckVariant): UpdateCheckOptions {
    switch (variant) {
      case 'perf':
        return { includePrerelease: true, includePerfPrerelease: true }
      case 'prerelease':
        return { includePrerelease: true }
      case 'default':
        return { includePrerelease: false }
    }
  }

  protected getUpdateCheckVariant(options?: UpdateCheckOptions): UpdateCheckVariant {
    if (options?.includePerfPrerelease) {
      return 'perf'
    }
    if (options?.includePrerelease) {
      return 'prerelease'
    }
    // Persisted RC preference applies to routine checks; dev channels still require explicit tags.
    if (this.getReleaseChannelOverride?.() === 'rc') {
      return 'prerelease'
    }
    return 'default'
  }

  protected launchPendingUserInitiatedCheckAfterInFlight(variant: UpdateCheckVariant): void {
    this.pendingUserInitiatedCheckAfterInFlight = null
    setTimeout(() => {
      // Wait one tick for electron-updater to clear its promise or the modifier check dedupes into the stable check.
      if (this.currentStatus.state === 'checking') {
        this.currentStatus = { state: 'idle' }
      }
      this.checkForUpdatesFromMenu(this.getOptionsForUpdateCheckVariant(variant))
    }, 0)
  }

  protected clearBackgroundCheckLaunchPending(): void {
    this.backgroundCheckLaunchPending = false
  }

  protected clearUpdateCheckStallTimer(): void {
    if (!this.updateCheckStallTimer) {
      return
    }
    clearTimeout(this.updateCheckStallTimer)
    this.updateCheckStallTimer = null
  }

  protected clearUpdateCheckSilentSettleTimer(): void {
    if (!this.updateCheckSilentSettleTimer) {
      return
    }
    clearTimeout(this.updateCheckSilentSettleTimer)
    this.updateCheckSilentSettleTimer = null
  }

  protected clearUpdateCheckTimers(): void {
    this.clearUpdateCheckStallTimer()
    this.clearUpdateCheckSilentSettleTimer()
  }

  protected finishActiveUpdateCheckAttempt(): void {
    this.activeUpdateCheckAttemptId = null
    this.activeUpdateCheckLaunchAttemptId = null
    this.activeUpdateCheckEventAttemptId = null
    this.clearUpdateCheckTimers()
  }

  protected getActiveUpdateCheckEventAttemptId(): number | null {
    if (this.activeUpdateCheckAttemptId === null) {
      return null
    }
    if (this.activeUpdateCheckEventAttemptId !== this.activeUpdateCheckAttemptId) {
      return null
    }
    return this.activeUpdateCheckAttemptId
  }

  protected isActiveUpdateCheckAttempt(attemptId: number): boolean {
    return this.activeUpdateCheckAttemptId === attemptId
  }

  protected markUpdateCheckEventAttempt(): boolean {
    if (this.activeUpdateCheckAttemptId === null) {
      return false
    }
    if (this.activeUpdateCheckLaunchAttemptId !== this.activeUpdateCheckAttemptId) {
      return false
    }
    this.activeUpdateCheckEventAttemptId = this.activeUpdateCheckAttemptId
    return true
  }

  protected markUpdateCheckLaunched(attemptId: number): void {
    if (!this.isActiveUpdateCheckAttempt(attemptId)) {
      return
    }
    this.activeUpdateCheckLaunchAttemptId = attemptId
  }

  protected markUpdateAvailableEventPending(attemptId: number | null): void {
    this.updateAvailableEventPendingAttemptId = attemptId
  }

  protected clearUpdateAvailableEventPending(attemptId: number | null): void {
    if (this.updateAvailableEventPendingAttemptId !== attemptId) {
      return
    }
    this.updateAvailableEventPendingAttemptId = null
  }

  protected armUpdateCheckStallTimer(attemptId: number): void {
    this.clearUpdateCheckStallTimer()
    this.updateCheckStallTimer = setTimeout(() => {
      this.updateCheckStallTimer = null
      if (!this.isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      const wasUserInitiated = this.getSettledCheckUserInitiated()
      if (this.currentStatus.state === 'checking') {
        this.finishActiveUpdateCheckAttempt()
        this.backgroundCheckLaunchPending = false
        this.backgroundCheckPromotedToUserInitiated = false
        this.userInitiatedCheck = false
        void this.sendCheckFailureStatus(
          'Update check timed out. Try again in a few minutes.',
          wasUserInitiated,
          'promise'
        )
        return
      }
      if (this.backgroundCheckLaunchPending) {
        this.finishActiveUpdateCheckAttempt()
        this.backgroundCheckLaunchPending = false
        this.backgroundCheckPromotedToUserInitiated = false
        this.userInitiatedCheck = false
        this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      }
    }, UPDATE_CHECK_STALL_TIMEOUT_MS)
  }

  protected beginUpdateCheckAttempt(): number {
    this.finishActiveUpdateCheckAttempt()
    this.updateAvailableEventPendingAttemptId = null
    this.updateCheckAttemptSequence += 1
    this.activeUpdateCheckAttemptId = this.updateCheckAttemptSequence
    this.armUpdateCheckStallTimer(this.activeUpdateCheckAttemptId)
    // Timestamp attempts to correlate recurring retry-cadence warnings (#7576).
    writeMainThreadDiagnosticMarker('updater-check-attempt')
    return this.activeUpdateCheckAttemptId
  }

  protected rearmActiveUpdateCheckStallTimer(): void {
    if (this.activeUpdateCheckAttemptId === null) {
      return
    }
    this.armUpdateCheckStallTimer(this.activeUpdateCheckAttemptId)
  }

  protected getSettledCheckUserInitiated(): boolean | undefined {
    return this.userInitiatedCheck || this.backgroundCheckPromotedToUserInitiated || undefined
  }

  protected isUpdateCheckResultState(state: UpdateStatus['state']): boolean {
    return (
      state === 'idle' ||
      state === 'not-available' ||
      state === 'available' ||
      state === 'error' ||
      state === 'downloading' ||
      state === 'downloaded'
    )
  }

  protected consumeSilentCheckShortRetryReason(): boolean {
    if (this.publishingWindowLastGoodCheck !== null) {
      return true
    }
    return this.consumeMissingManifestPrereleaseFallbackResult() !== null
  }

  protected completeSilentUpdateCheck(userInitiated: boolean | undefined): boolean {
    const shouldRetrySoon = this.consumeSilentCheckShortRetryReason()
    this.clearAvailableUpdateContext()
    if (shouldRetrySoon) {
      // Last-good silent results remain release transitions; preserve the short publishing retry.
      this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      return true
    }
    this.recordCompletedUpdateCheck()
    if (!userInitiated) {
      this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
    return false
  }

  protected settleSilentUpdateCheck(attemptId: number, userInitiated: boolean | undefined): void {
    if (!this.isActiveUpdateCheckAttempt(attemptId)) {
      return
    }
    if (this.updateAvailableEventPendingAttemptId === attemptId) {
      return
    }
    if (this.currentStatus.state !== 'checking') {
      if (this.backgroundCheckLaunchPending) {
        this.finishActiveUpdateCheckAttempt()
        this.clearBackgroundCheckLaunchPending()
        this.backgroundCheckPromotedToUserInitiated = false
        this.userInitiatedCheck = false
        const shouldRetrySoon = this.completeSilentUpdateCheck(userInitiated)
        if (this.awaitingNudgeCheckOutcome) {
          if (shouldRetrySoon) {
            this.deferPendingUpdateNudgeUntilRetry()
            return
          }
          this.sendSettledCheckStatus({ state: 'not-available', userInitiated })
        }
      }
      return
    }
    this.finishActiveUpdateCheckAttempt()
    this.clearBackgroundCheckLaunchPending()
    this.backgroundCheckPromotedToUserInitiated = false
    this.userInitiatedCheck = false
    this.completeSilentUpdateCheck(userInitiated)
    this.sendSettledCheckStatus({ state: 'not-available', userInitiated })
  }

  protected handleSettledUpdateCheckPromise(attemptId: number): void {
    if (!this.isActiveUpdateCheckAttempt(attemptId)) {
      return
    }
    this.clearUpdateCheckSilentSettleTimer()
    // Promise resolution may precede the terminal event; allow a grace period before unsticking silent checks.
    this.updateCheckSilentSettleTimer = setTimeout(() => {
      this.updateCheckSilentSettleTimer = null
      this.settleSilentUpdateCheck(attemptId, this.getSettledCheckUserInitiated())
    }, UPDATE_CHECK_SILENT_SETTLE_DELAY_MS)
  }

  protected shouldHandleUpdaterErrorEvent(): boolean {
    if (this.getActiveUpdateCheckEventAttemptId() !== null) {
      return true
    }
    // After check settlement, global errors belong only to active download/install flows.
    return (
      this.downloadInFlight ||
      this.currentStatus.state === 'downloading' ||
      this.currentStatus.state === 'downloaded'
    )
  }

  protected sendErrorStatus(failure: string | UpdaterCodedMessage, userInitiated?: boolean): void {
    const coded = typeof failure === 'string' ? { message: failure } : failure
    const { message } = coded
    if (
      this.currentStatus.state === 'error' &&
      this.currentStatus.message === message &&
      this.currentStatus.userInitiated === userInitiated
    ) {
      return
    }
    // Measure AV/EDR-blocked signature checks before changing updater policy.
    if (isWindowsSignatureCheckUnavailableFailure(message)) {
      recordUpdaterLifecycle('windows_signature_check_blocked', undefined, {
        level: 'warn',
        message: 'Windows update signature check could not run'
      })
    }
    this.sendStatus({ state: 'error', ...coded, userInitiated })
  }

  /** Retain the distro-package manual-install card when settling a check; ordinary status would erase it. */
  protected sendSettledCheckStatus(status: UpdateStatus): void {
    const retainedStatus = getRetainedLinuxPackageManualInstallStatus()
    if (retainedStatus) {
      this.sendStatus(retainedStatus)
    } else if (status.state === 'error') {
      const { message, messageCode, messageParams } = status
      this.sendErrorStatus(
        {
          message,
          ...(messageCode === undefined ? {} : { messageCode }),
          ...(messageParams === undefined ? {} : { messageParams })
        },
        status.userInitiated
      )
    } else {
      this.sendStatus(status)
    }
  }

  protected abstract consumeMissingManifestPrereleaseFallbackResult(): {
    userInitiated: boolean
  } | null
  protected abstract recordCompletedUpdateCheck(): void
  protected abstract sendCheckFailureStatus(
    message: string,
    userInitiated?: boolean,
    source?: 'event' | 'promise' | 'fallback-promise',
    sourceError?: unknown
  ): Promise<void>
  protected abstract scheduleAutomaticUpdateCheck(delayMs: number): void
}
