import { app } from 'electron'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import type { UpdateInstallTrigger } from './updater-state'
import type { TeamUpdateRestartScope } from './team-update-restart-record'
import { TeamUpdateRestartController } from './team-update-restart'
import { UpdaterRemoteStatus } from './updater-remote-status'

const DEFAULT_RESTART_DEADLINE_HOURS = 24

export type TeamRestartOptions = {
  scope: () => TeamUpdateRestartScope | undefined
  hasWorkingAgents: () => boolean
}

export abstract class UpdaterRequiredRestart extends UpdaterRemoteStatus {
  protected teamRestartOptions: TeamRestartOptions | undefined
  private lastTeamDownload: string | undefined

  protected readonly teamRestart = new TeamUpdateRestartController({
    scope: () => this.teamRestartOptions?.scope(),
    deadlineHours: (version) =>
      this.currentStatus.state === 'downloaded' &&
      !this.currentStatus.installing &&
      this.currentStatus.version === version &&
      this.isRequiredTeamUpdate(version)
        ? (this.getTeamUpdatePolicy?.()?.restartDeadlineHours ?? DEFAULT_RESTART_DEADLINE_HOURS)
        : undefined,
    hasWorkingAgents: () => this.teamRestartOptions?.hasWorkingAgents() ?? false,
    publish: (version, teamRestart) => {
      if (this.currentStatus.state === 'downloaded' && this.currentStatus.version === version) {
        this.sendStatus({ ...this.currentStatus, requiredByTeam: true, teamRestart })
      }
    },
    install: () => this.quitAndInstall('team-policy')
  })

  snoozeRequiredUpdate(): Promise<void> {
    return this.teamRestart.snooze()
  }

  applyTeamPolicyBeforeQuit(): void {
    if (this.autoUpdater && this.implicitInstallOnQuit) {
      const version = this.getPendingInstallVersion()
      this.autoUpdater.autoInstallOnAppQuit =
        !this.isMacStagingDeferredToInstall() &&
        !this.shouldDeferTeamMacStaging() &&
        this.lastTeamDownload !== version &&
        !this.isRequiredTeamUpdate(version) &&
        this.allowsCurrentTeamUpdate(version)
    }
  }

  protected publishRequiredDownload(status: Extract<UpdateStatus, { state: 'downloaded' }>): void {
    this.lastTeamDownload = status.version
    this.sendStatus({ ...status, requiredByTeam: true })
    void this.teamRestart.verified(status.version, app.getVersion()).catch((error) => {
      console.warn('[updater] Could not save team restart state:', error)
    })
  }

  protected async performRecordedInstall(trigger: UpdateInstallTrigger): Promise<void> {
    const version = this.getPendingInstallVersion()
    if (trigger === 'team-policy' || this.isRequiredTeamUpdate(version)) {
      const recordSaved = await this.teamRestart
        .recordAttempt(version, trigger === 'team-policy')
        .catch((error) => {
          console.warn('[updater] Could not record team install attempt:', error)
          return trigger !== 'team-policy'
        })
      if (!recordSaved) {
        this.pendingQuitAndInstallTimer = null
        this.resetQuitForUpdateState()
        return
      }
    }
    await this.performQuitAndInstall(trigger)
  }

  protected sendInstallFailureStatus(status: UpdateStatus): void {
    const version = this.getPendingInstallVersion()
    super.sendInstallFailureStatus(
      status.state === 'error' &&
        this.isRequiredTeamUpdate(version) &&
        this.teamRestart.exhausted(version)
        ? { ...status, version, requiredByTeam: true, retryable: false }
        : status
    )
  }

  protected abstract quitAndInstall(trigger?: UpdateInstallTrigger): void
}
