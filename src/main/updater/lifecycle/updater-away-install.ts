import { app, powerMonitor } from 'electron'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import { readDesktopAwayState } from '../../notifications/desktop-away-state'
import { AWAY_IDLE_SECONDS, AwayRestartController } from '../away-install/away-restart-controller'
import { isPrereleaseVersion, statusesEqual } from '../releases/updater-fallback'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { UpdaterDownloadInstall } from './updater-download-install'
import type { UpdateCheckVariant } from './updater-types'

export abstract class UpdaterAwayInstall extends UpdaterDownloadInstall {
  protected getInstallUpdatesWhenAway: (() => boolean) | null = null
  protected findRestartInterruptingWork: (() => string | null) | null = null
  private releaseCheckIsStableDefault = false
  private offeredReleaseIsStableDefault = false
  private unattendedDownload = false

  private readonly awayRestart = new AwayRestartController({
    isEligible: () => this.isUnattendedEligible(),
    readAway: () => readDesktopAwayState(powerMonitor, AWAY_IDLE_SECONDS),
    readIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime()
      } catch {
        return Number.NaN
      }
    },
    findInterruptingWork: () =>
      this.findRestartInterruptingWork ? this.findRestartInterruptingWork() : 'unavailable',
    now: Date.now,
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    publish: () => {
      const current = this.currentStatus
      if (current.state !== 'downloaded') {
        return
      }
      const next = this.decorateAwayRestartStatus(current)
      if (statusesEqual(current, next)) {
        return
      }
      this.currentStatus = next
      this.sendToMainWindow('updater:status', next)
    },
    requestRestart: () => {
      const window = this.getMainWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        return false
      }
      this.sendToMainWindow('updater:autoRestartDue')
      return true
    },
    record: recordUpdaterLifecycle
  })

  declineAutoRestart(): void {
    if (this.currentStatus.state !== 'downloaded') {
      return
    }
    const { version } = this.currentStatus
    if (this.awayRestart.isDeclined(version)) {
      return
    }
    if (this.awayRestart.decline()) {
      recordUpdaterLifecycle('auto_restart_declined', { version })
    }
  }

  protected installAwayRestartSignals(): void {
    powerMonitor.on('lock-screen', () => this.awayRestart.evaluateNow())
    powerMonitor.on('unlock-screen', () => this.awayRestart.interrupt('presence'))
    powerMonitor.on('suspend', () => this.awayRestart.interrupt('suspend'))
  }

  protected override quitAndInstall(options?: { unattended?: boolean }): void {
    if (options?.unattended === true && !this.awayRestart.confirmUnattendedRestart()) {
      this.sendToMainWindow('updater:quitAndInstallAborted')
      return
    }
    super.quitAndInstall()
  }

  protected override pinDefaultReleaseFeed(
    variant: UpdateCheckVariant = 'default'
  ): Promise<'ready' | 'not-available'> {
    this.releaseCheckIsStableDefault =
      variant === 'default' &&
      !this.includePrereleaseActive &&
      !isPrereleaseVersion(app.getVersion())
    return super.pinDefaultReleaseFeed(variant)
  }

  protected override sendStatus(status: UpdateStatus, options?: { force?: boolean }): void {
    if (status.state === 'available') {
      this.offeredReleaseIsStableDefault = this.releaseCheckIsStableDefault
    }
    const decorated = this.decorateAwayRestartStatus(status)
    if (status.state !== 'downloading') {
      this.unattendedDownload = false
    }
    super.sendStatus(decorated, options)
    if (this.currentStatus.state === 'available' && this.currentStatus.unattended) {
      this.unattendedDownload = true
      this.downloadUpdate()
      if (this.currentStatus.state === 'available') {
        this.unattendedDownload = false
      }
    }
    this.awayRestart.follow(this.currentStatus)
  }

  private isUnattendedEligible(): boolean {
    return (
      this.autoUpdaterInitialized &&
      this.getInstallUpdatesWhenAway?.() === true &&
      this.activeUpdateSource === 'release' &&
      this.offeredReleaseIsStableDefault &&
      !this.isPinnedBuildActive &&
      // Setup sets this only for interactive installs a normal quit can finish.
      this.getAutoUpdater().autoInstallOnAppQuit
    )
  }

  private decorateAwayRestartStatus(status: UpdateStatus): UpdateStatus {
    if (status.state === 'error' && this.unattendedDownload) {
      return { ...status, unattended: true }
    }
    if (
      status.state !== 'available' &&
      status.state !== 'downloading' &&
      status.state !== 'downloaded'
    ) {
      return status
    }
    const decorated = { ...status }
    delete decorated.unattended
    if (decorated.state === 'downloaded') {
      delete decorated.autoRestartAt
    }
    if (!this.isUnattendedEligible()) {
      return decorated
    }
    if (decorated.state === 'available' && decorated.externallyManaged) {
      return decorated
    }
    if (decorated.state === 'downloaded') {
      if (decorated.installing || this.awayRestart.isDeclined(decorated.version)) {
        return decorated
      }
      const deadline = this.awayRestart.countdownDeadline(decorated.version)
      if (deadline !== null) {
        decorated.autoRestartAt = deadline
      }
    }
    decorated.unattended = true
    return decorated
  }
}
