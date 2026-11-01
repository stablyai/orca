import { app } from 'electron'
import { fetchNudge, shouldApplyNudge } from '../updater-nudge'
import { NUDGE_ACTIVATION_COOLDOWN_MS, NUDGE_POLL_INTERVAL_MS } from './updater-state'
import { UpdaterBuildSelection } from './updater-build-selection'

export abstract class UpdaterNudge extends UpdaterBuildSelection {
  protected async checkForUpdateNudge(): Promise<void> {
    if (!app.isPackaged) {
      return
    }
    if (this.nudgeCheckInFlight) {
      return
    }
    const now = Date.now()
    if (now - this.lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
      return
    }
    this.lastNudgeCheckAt = now
    this.nudgeCheckInFlight = true
    try {
      const nudge = await fetchNudge()
      if (!nudge) {
        return
      }
      if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
        return
      }
      const appVersion = app.getVersion()
      const pendingUpdateNudgeId = this._getPendingUpdateNudgeId?.() ?? null
      const dismissedUpdateNudgeId = this._getDismissedUpdateNudgeId?.() ?? null
      if (
        shouldApplyNudge({
          nudge,
          appVersion,
          pendingUpdateNudgeId,
          dismissedUpdateNudgeId
        })
      ) {
        this.awaitingNudgeCheckOutcome = true
        this._setPendingUpdateNudgeId?.(nudge.id)
        this.sendToMainWindow('updater:clearDismissal')
        this.runBackgroundUpdateCheck(nudge.id)
      }
    } finally {
      this.nudgeCheckInFlight = false
    }
  }

  protected scheduleUpdateNudgeCheck(): void {
    if (this.nudgeCheckTimer) {
      clearTimeout(this.nudgeCheckTimer)
    }
    this.nudgeCheckTimer = setTimeout(() => {
      void this.checkForUpdateNudge()
      this.scheduleUpdateNudgeCheck()
    }, NUDGE_POLL_INTERVAL_MS)
  }

  protected dismissNudge(): void {
    const pendingId = this.activeUpdateNudgeId ?? this._getPendingUpdateNudgeId?.() ?? null
    if (pendingId) {
      this._setDismissedUpdateNudgeId?.(pendingId)
      this.clearPendingUpdateNudge()
    }
  }

  /** Abandon only an unacted local/pinned update and restore the release feed. */
  protected dismissAvailableUpdate(): void {
    if (this.activeUpdateSource === 'release' && !this.isPinnedBuildActive) {
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    // Downloading/downloaded cards still own the pinned feed and downgrade permission.
    if (this.currentStatus.state !== 'available') {
      return
    }
    this.clearAvailableUpdateContext()
    this.restoreReleaseUpdateSource()
    // Clear available status or Retry could download the abandoned version from the restored feed.
    this.sendStatus({ state: 'idle' })
  }
}
