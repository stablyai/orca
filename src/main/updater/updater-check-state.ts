import { writeMainThreadDiagnosticMarker } from '../diagnostics/main-thread-churn-probe'
import { isWindowsSignatureCheckUnavailableFailure } from '../../shared/updater-windows-signature-check'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { getRetainedLinuxPackageManualInstallStatus } from '../linux-package-downloaded-status'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type { UpdateCheckVariant } from './updater-types'
import { UpdaterStatus } from './updater-status'
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
    // Why: a persisted 'rc' override makes every routine check follow the RC series
    // without the user re-holding shift; the dev channels need an explicit tag, so
    // neither is a routine-check variant.
    if (this.getReleaseChannelOverride?.() === 'rc') {
      return 'prerelease'
    }
    return 'default'
  }

  protected launchPendingUserInitiatedCheckAfterInFlight(variant: UpdateCheckVariant): void {
    this.pendingUserInitiatedCheckAfterInFlight = null
    setTimeout(() => {
      // Why: defer one tick after electron-updater clears its in-flight promise so the queued modifier check starts fresh instead of deduping into the stable one.
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
    // Why: issue #7576 warnings recurred at retry cadence; timestamp each attempt to confirm or rule out the updater.
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
      // Why: a silent result against a temporary last-good feed is still a release transition, so it must not suppress the short publish retry.
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
    // Why: electron-updater can resolve before the terminal event arrives; grace-period it, then unstick checks that resolved without one.
    this.updateCheckSilentSettleTimer = setTimeout(() => {
      this.updateCheckSilentSettleTimer = null
      this.settleSilentUpdateCheck(attemptId, this.getSettledCheckUserInitiated())
    }, UPDATE_CHECK_SILENT_SETTLE_DELAY_MS)
  }

  protected shouldHandleUpdaterErrorEvent(): boolean {
    if (this.getActiveUpdateCheckEventAttemptId() !== null) {
      return true
    }
    // Why: electron-updater emits check errors globally; once a check settles, only active download/install flows should consume them.
    return (
      this.downloadInFlight ||
      this.currentStatus.state === 'downloading' ||
      this.currentStatus.state === 'downloaded'
    )
  }

  protected sendErrorStatus(message: string, userInitiated?: boolean): void {
    if (
      this.currentStatus.state === 'error' &&
      this.currentStatus.message === message &&
      this.currentStatus.userInitiated === userInitiated
    ) {
      return
    }
    // Why: count AV/EDR-blocked Windows signature checks in the field to size the affected cohort before bigger updater changes.
    if (isWindowsSignatureCheckUnavailableFailure(message)) {
      recordUpdaterLifecycle('windows_signature_check_blocked', undefined, {
        level: 'warn',
        message: 'Windows update signature check could not run'
      })
    }
    this.sendStatus({ state: 'error', message, userInitiated })
  }

  /**
   * Settles a check without discarding a retained manual-install card. A distro-managed host has a
   * downloaded package it can still be told about, and the ordinary settle status would erase it.
   */
  protected sendSettledCheckStatus(status: UpdateStatus): void {
    const retainedStatus = getRetainedLinuxPackageManualInstallStatus()
    if (retainedStatus) {
      this.sendStatus(retainedStatus)
    } else if (status.state === 'error') {
      this.sendErrorStatus(status.message, status.userInitiated)
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
