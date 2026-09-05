import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../shared/remote-server-update'
import { hasServeUpdateSupervisor } from '../serve-update-handoff'
import { getLinuxPackageType } from '../linux-update-package-type'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { UpdaterNudge } from './updater-nudge'
import type { UpdateInstallMode } from './updater-state'

export type ServeUpdateCensusGate = () => Promise<{ ok: true } | { ok: false; reason: string }>

/** Exposes updater state to runtime RPC callers without leaking internal mutators. */
export abstract class UpdaterRemoteStatus extends UpdaterNudge {
  /** Set by serve startup; a null gate means interactive installs need no census. */
  private serveUpdateCensusGate: ServeUpdateCensusGate | null = null

  setServeUpdateCensusGate(gate: ServeUpdateCensusGate | null): void {
    this.serveUpdateCensusGate = gate
  }
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
    // Why: the verdict must reflect what installRemoteServerUpdate will actually accept —
    // on supervised Linux serve that is the root helper. Interactive desktop installs
    // never route through the helper, so the gate must not bind them.
    if (this.updateInstallMode === 'supervised-headless-serve' && !hasServeUpdateSupervisor()) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'updater-unavailable'
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

  protected async installRemoteServerUpdate(
    runtimeId: string
  ): Promise<RemoteServerUpdateInstallResult> {
    this.assertRemoteServerUpdateAvailable()
    if (this.currentStatus.state !== 'downloaded') {
      throw new Error('remote_update_not_downloaded')
    }
    // Why: the install RPC is the one path that ends in a server restart, so the
    // census gate runs here — as close to the quit as possible — rather than in
    // the check/download paths that do not kill anything.
    if (this.serveUpdateCensusGate) {
      const census = await this.serveUpdateCensusGate()
      if (!census.ok) {
        recordUpdaterLifecycle(
          'headless_serve_update_census_blocked',
          { reason: census.reason },
          { level: 'warn', message: 'Server update blocked: live terminals may exist' }
        )
        throw new Error('remote_update_live_terminals')
      }
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
