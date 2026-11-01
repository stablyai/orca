import { homedir } from 'node:os'
import { getMacUpdateRunningInstances } from '../macos-update-running-instances'
import { setMacInstallPreflightInProgress } from '../updater-mac-install'
import { macCoordinationRoot } from '../../shared/serve-bundle-coordination'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  recoverMacBrowserSidecars,
  describeMacUpdateBlockers
} from './mac-browser-sidecar-recovery'
import {
  parkServeSupervisorsForInstall,
  serveInstallRefusalMessage
} from './serve-supervisor-install-park'
import { UpdaterPackageRecovery } from './updater-package-recovery'

export abstract class UpdaterMacInstallPreflight extends UpdaterPackageRecovery {
  protected async preflightMacInstall(pendingVersion: string): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return true
    }
    setMacInstallPreflightInProgress(true)
    let blockers: number[]
    try {
      blockers = await getMacUpdateRunningInstances()
      blockers = await recoverMacBrowserSidecars(process.execPath, blockers)
    } catch {
      this.resetQuitForUpdateState()
      this.sendToMainWindow('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        version: pendingVersion,
        retryAction: 'install',
        message:
          'Could not check for other running Orca instances. Orca remains open. Try again. If the check keeps failing, close the other Orca instances and background orca serve servers, then quit Orca to let the update install on exit. Reopen Orca afterwards.'
      })
      recordUpdaterLifecycle('macos_running_instances_check_failed')
      return false
    }
    // Registered serve supervisors can park their servers; other blockers remain refused.
    const park =
      blockers.length > 0
        ? await parkServeSupervisorsForInstall(process.execPath, blockers, {
            macUserDataRoot: macCoordinationRoot(homedir()),
            listBlockers: () => getMacUpdateRunningInstances()
          })
        : null
    if (park && park.kind === 'refused') {
      const instances = await describeMacUpdateBlockers(process.execPath, park.pids)
      this.resetQuitForUpdateState()
      this.sendToMainWindow('updater:quitAndInstallAborted')
      this.sendInstallFailureStatus({
        state: 'error',
        version: pendingVersion,
        retryAction: 'install',
        message: serveInstallRefusalMessage(park),
        installBlock: {
          reason: park.reason === 'unregistered' ? 'running-instances' : park.reason,
          instances
        }
      })
      recordUpdaterLifecycle('macos_install_blocked_by_running_instances', {
        pids: park.pids.slice(0, 10).join(', '),
        count: park.pids.length,
        reason: park.reason
      })
      return false
    }

    return true
  }
}
