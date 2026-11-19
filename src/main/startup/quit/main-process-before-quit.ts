import { awaitPackedRefsLockRelease } from '../../git/refs/maintenance/local-repo-ref-maintenance'
import { cancelHistoryGc } from '../../pty/history/terminal-history-gc'
import { fenceMainProcessCloudOnQuit } from '../cloud-startup/main-process-connector-startup'
import { app, type Event } from 'electron'
import { mainProcessState as state } from '../main-process-state'
import { isQuittingForUpdate } from '../../updater/updater-service'
import { recordUpdaterLifecycle } from '../../updater/updater-lifecycle-diagnostics'

export function installBeforeQuitHandler(): void {
  app.on('before-quit', (event: Event) => {
    if (event.defaultPrevented) {
      return
    }
    if (isQuittingForUpdate()) {
      recordUpdaterLifecycle('before_quit_allowed', undefined, {
        message: 'before-quit allowed for update install'
      })
    }
    state.isQuitting = true
    fenceMainProcessCloudOnQuit()
    state.runtimeRpc?.setMobileRelayPairingProvider(null)
    state.unsubscribeAgentAwakeStatusChanges?.()
    state.unsubscribeAgentAwakeStatusChanges = null
    state.agentAwakeService?.dispose()
    state.agentAwakeService = null
    // Renderer vetoes still apply; isQuitting blocks new maintenance while locks drain.
    state.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
    // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
    state.rateLimits?.stop()
    // A veto only defers this idempotent sweep until next launch.
    cancelHistoryGc()
  })
}
