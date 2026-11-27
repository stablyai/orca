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
        this.sendStatus({
          ...this.currentStatus,
          ...this.requiredUpdateStatusFields(),
          teamRestart
        })
      }
    },
    install: (isCurrent) => this.quitAndInstall('team-policy', isCurrent)
  })

  snoozeRequiredUpdate(): Promise<void> {
    return this.teamRestart.snooze()
  }

  protected invalidateTeamRestart(): boolean {
    this.teamRestart.cancel()
    const status = this.currentStatus
    if (status.state !== 'downloaded' || !status.requiredByTeam || status.installing) {
      return false
    }
    const {
      teamRestart: _restart,
      requiredByTeam: _team,
      requiredByOrca: _orca,
      ...download
    } = status
    if (this.isRequiredTeamUpdate(download.version)) {
      this.publishRequiredDownload(download)
      return true
    }
    this.sendStatus(download)
    return false
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

  protected requiredUpdateStatusFields(): { requiredByTeam: true; requiredByOrca?: true } {
    return this.getTeamUpdatePolicy?.()?.emergency
      ? { requiredByTeam: true, requiredByOrca: true }
      : { requiredByTeam: true }
  }

  protected publishRequiredDownload(status: Extract<UpdateStatus, { state: 'downloaded' }>): void {
    this.lastTeamDownload = status.version
    this.sendStatus({ ...status, ...this.requiredUpdateStatusFields() })
    void this.teamRestart.verified(status.version, app.getVersion()).catch((error) => {
      console.warn('[updater] Could not save team restart state:', error)
    })
  }

  protected async performRecordedInstall(
    trigger: UpdateInstallTrigger,
    isCurrentTeamRestart?: () => boolean
  ): Promise<void> {
    const version = this.getPendingInstallVersion()
    if (isCurrentTeamRestart && !isCurrentTeamRestart()) {
      this.pendingQuitAndInstallTimer = null
      this.resetQuitForUpdateState()
      return
    }
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
    await this.performQuitAndInstall(trigger, isCurrentTeamRestart)
  }

  protected sendInstallFailureStatus(status: UpdateStatus): void {
    const version = this.getPendingInstallVersion()
    super.sendInstallFailureStatus(
      status.state === 'error' &&
        this.isRequiredTeamUpdate(version) &&
        this.teamRestart.exhausted(version)
        ? { ...status, version, ...this.requiredUpdateStatusFields(), retryable: false }
        : status
    )
  }

  protected abstract quitAndInstall(
    trigger?: UpdateInstallTrigger,
    isCurrentTeamRestart?: () => boolean
  ): void
}
