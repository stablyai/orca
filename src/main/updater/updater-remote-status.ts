import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../shared/remote-server-update'
import { hasServeUpdateSupervisor } from '../serve-update-handoff'
import { getServeManualUpdateReport } from '../serve-manual-update-report'
import { getLinuxPackageType } from '../linux-update-package-type'
import { UpdaterNudge } from './updater-nudge'
import type { UpdateInstallMode } from './updater-state'

/** Exposes updater state to runtime RPC callers without leaking internal mutators. */
export abstract class UpdaterRemoteStatus extends UpdaterNudge {
  protected getUpdateStatus(): UpdateStatus {
    return this.currentStatus
  }

  protected getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
    if (!app.isPackaged || is.dev) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'unpackaged-build'
      }
    }
    // Why: checked before the initialization gate — a headless serve host never wires an updater,
    // so reporting `updater-unavailable` there described a broken desktop install rather than a
    // server that is correctly refusing to update itself (#14068).
    if (this.updateInstallMode === 'unsupported-headless-serve') {
      const manualUpdate = getServeManualUpdateReport()
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'manual-service-update-required',
        ...(manualUpdate ? { manualUpdate } : {})
      }
    }
    if (!this.autoUpdaterInitialized) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'updater-unavailable'
      }
    }
    // Why: the headless-serve case already returned above, so this clause is purely about a
    // distro-managed install whose updater did initialize (#18100).
    const linuxPackageType = getLinuxPackageType()
    if (
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
    this.checkForUpdatesFromMenu(options)
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
    this.assertRemoteServerUpdateAvailable()
    if (this.currentStatus.state !== 'available') {
      throw new Error('remote_update_not_available')
    }
    this.downloadUpdate()
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
    this.assertRemoteServerUpdateAvailable()
    if (this.currentStatus.state !== 'downloaded') {
      throw new Error('remote_update_not_downloaded')
    }
    const targetVersion = this.currentStatus.version
    const result: RemoteServerUpdateInstallResult = {
      accepted: true,
      fromVersion: app.getVersion(),
      targetVersion,
      runtimeId
    }
    this.quitAndInstall()
    return result
  }

  protected resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
    if (!isServeMode) {
      return 'interactive'
    }
    return hasServeUpdateSupervisor() ? 'supervised-headless-serve' : 'unsupported-headless-serve'
  }

  protected abstract downloadUpdate(): void
  protected abstract quitAndInstall(): void
}
