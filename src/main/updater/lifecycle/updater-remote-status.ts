import { app } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import type { UpdateCheckOptions, UpdateStatus } from '../../../shared/updater/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../../shared/remote-runtime/host-catalog/remote-server-update'
import { hasServeUpdateSupervisor } from '../serve-update-handoff'
import { getLinuxPackageType } from '../linux-package/linux-update-package-type'
import { UpdaterNudge } from '../nudges/updater-nudge'
import type { UpdateInstallMode, UpdateInstallTrigger } from './updater-state'

export abstract class UpdaterRemoteStatus extends UpdaterNudge {
  protected getUpdateStatus(): UpdateStatus {
    return this.currentStatus
  }

  protected getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
    if (!app.isPackaged) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'unpackaged-build'
      }
    }
    if (!this.autoUpdaterInitialized) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'updater-unavailable'
      }
    }
    const linuxPackageType = getLinuxPackageType()
    if (
      this.updateInstallMode === 'unsupported-headless-serve' ||
      linuxPackageType === 'deb' ||
      linuxPackageType === 'rpm' ||
      linuxPackageType === 'unusable'
    ) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'manual-service-update-required'
      }
    }
    return { installMode: this.updateInstallMode, automatic: true, reason: 'available' }
  }

  protected getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
    return {
      appVersion: app.getVersion(),
      runtimeId,
      support: this.getRemoteServerUpdateSupport(),
      status: this.getUpdateStatus()
    }
  }

  protected assertRemoteServerUpdateAvailable(): void {
    if (!this.getRemoteServerUpdateSupport().automatic) {
      throw new Error('remote_update_manual_required')
    }
  }

  protected checkForRemoteServerUpdate(
    runtimeId: string,
    options?: UpdateCheckOptions
  ): RemoteServerUpdaterSnapshot {
    this.assertRemoteServerUpdateAvailable()
    this.assertRemoteUpdaterIdle()
    this.checkForUpdatesFromMenu(options)
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
    this.assertRemoteServerUpdateAvailable()
    this.assertRemoteUpdaterIdle()
    if (this.currentStatus.state !== 'available') {
      throw new Error('remote_update_not_available')
    }
    this.downloadUpdate()
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
    this.assertRemoteServerUpdateAvailable()
    this.assertRemoteUpdaterIdle()
    if (this.currentStatus.state !== 'downloaded') {
      throw new Error('remote_update_not_downloaded')
    }
    const targetVersion = this.currentStatus.version
    if (this.holdUpdateForTeamPolicy(targetVersion)) {
      throw new Error('remote_update_not_available')
    }
    const result: RemoteServerUpdateInstallResult = {
      accepted: true,
      fromVersion: app.getVersion(),
      targetVersion,
      runtimeId
    }
    // No local window asked, so main must back up editors and save state before the restart.
    this.quitAndInstall('remote')
    return result
  }

  private assertRemoteUpdaterIdle(): void {
    if (
      this.macInstallerStagingVersion !== null ||
      this.currentStatus.state === 'downloading' ||
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress
    ) {
      throw new Error(
        translateMain(
          'updates.remoteUpdateBusy',
          'This server is already updating. Check again once it finishes.'
        )
      )
    }
  }

  protected resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
    if (!isServeMode) {
      return 'interactive'
    }
    return hasServeUpdateSupervisor() ? 'supervised-headless-serve' : 'unsupported-headless-serve'
  }

  protected abstract downloadUpdate(): void
  protected abstract quitAndInstall(trigger: UpdateInstallTrigger): void
}
