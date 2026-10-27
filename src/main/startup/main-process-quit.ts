import { app, type Event } from 'electron'
import { settleTeardownWithinDeadline, settleWithinMs } from '../quit-teardown-deadline'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { shouldQuitWhenAllWindowsClosed } from './window-all-closed-quit-policy'
import { desktopConnectorCloud } from './main-process-connector-startup'
import { mainProcessState as state } from './main-process-state'
import { devParentShutdownState } from './dev-parent-shutdown-state'
import { runQuitTasks, type QuitTaskContext } from '../quit-task-registry'

// First will-quit pass awaits teardown; the re-fired pass must exit without starting writes again.
let daemonDisconnectDone = false
let watcherShutdownPromise: Promise<void> | null = null
// Allow pack-refs time to terminate and unlink its lock.
const REF_MAINTENANCE_QUIT_DEADLINE_MS = 2_000

function shutdownWatchersOnce(context: QuitTaskContext): Promise<void> {
  if (state.watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Await native watcher unsubscribe before Node environment teardown.
    runQuitTasks('folder-watchers', context)
    watcherShutdownPromise = Promise.allSettled([
      runQuitTasks('filesystem-watchers', context),
      runQuitTasks('base-directory-watchers', context)
    ])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[filesystem-watcher] shutdown failed:', result.reason)
          }
        }
      })
      .then(() => {
        state.watcherShutdownDone = true
      })
  }
  return watcherShutdownPromise
}

function installBeforeQuitHandler(): void {
  app.on('before-quit', (event: Event) => {
    if (event.defaultPrevented) {
      return
    }
    const context: QuitTaskContext = { isUpdate: false, shutdownDaemon: false }
    runQuitTasks('before-quit-update', context)
    state.isQuitting = true
    runQuitTasks('cloud-sessions', context)
    state.desktopRelayService?.fenceAndCloseNow()
    desktopConnectorCloud()?.fence()
    state.runtimeRpc?.setMobileRelayPairingProvider(null)
    state.unsubscribeAgentAwakeStatusChanges?.()
    state.unsubscribeAgentAwakeStatusChanges = null
    state.agentAwakeService?.dispose()
    state.agentAwakeService = null
    // Beforeunload may veto; wait for ref locks now but uninstall only after committed quit. isQuitting already blocks new attempts.
    state.repoMaintenanceShutdown = runQuitTasks('ref-maintenance', context)
    // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
    state.rateLimits?.stop()
    // History GC is idempotent and rescheduled next launch; a vetoed quit costs only a deferred sweep.
    runQuitTasks('history-gc', context)
  })
}

function installWillQuitHandler(): void {
  app.on('will-quit', (event: Event) => {
    // The second pass must not start fresh writes that process exit would interrupt.
    if (daemonDisconnectDone) {
      return
    }
    // Prevent exit before awaiting work. Synchronous network-profile writes would block the same thread as their deadline timer (#9447).
    if (!quitTeardownStartGate.tryStart(event)) {
      return
    }
    const context: QuitTaskContext = {
      isUpdate: false,
      shutdownDaemon: devParentShutdownState.requested
    }
    // Include pane grids still inside their write burst in final save.
    const paneGridFlush = state.runtime?.flushPaneGrids() ?? null
    // A renderer can veto before-quit; push must survive until quit is committed.
    state.desktopPushService?.stop()
    state.unsubscribeSystemResumeBroadcast?.()
    state.unsubscribeSystemResumeBroadcast = null
    state.stopDesktopPresenceReporter?.()
    state.stopDesktopPresenceReporter = null
    // Keep log-stream diagnostics alive through renderer quit vetoes.
    runQuitTasks('tcc-notice', context)
    runQuitTasks('will-quit-update', context)
    // Remove the Windows tray icon only after renderer vetoes are past.
    runQuitTasks('tray', context)
    // Final stats flush closes working sessions synchronously; quit supplies no terminating hook to preserve their duration.
    state.starNag?.stop()
    state.automations?.stop()
    // Await plugin shutdown/SIGKILL escalation or forked hosts can outlive Electron.
    state.pluginKillListService = null
    state.pluginMarketplaceService = null
    state.pluginMarketplaceInstaller = null
    const pluginHostShutdown = state.pluginService?.dispose() ?? Promise.resolve()
    const codexBackfillRecoveryShutdown = runQuitTasks('codex-backfill', context)
    runQuitTasks('codex-bridges', context)
    // Stamp resume reasons before stopping sessions; an update restart was not a user quit.
    const structuredAgentSessionShutdown = runQuitTasks('structured-sessions', context).then(() =>
      runQuitTasks('structured-record-store', context)
    )
    state.pluginService = null
    runQuitTasks('dock', context)
    // Wait briefly for ref maintenance instead of killing mid-prune and stranding its lock; an orphan can finish safely.
    const refMaintenanceShutdown = settleWithinMs(
      Promise.all([state.repoMaintenanceShutdown, state.uninstallRepoMaintenanceIdleGate?.()]).then(
        () => {}
      ),
      REF_MAINTENANCE_QUIT_DEADLINE_MS
    ).then(() => {})
    state.uninstallRepoMaintenanceIdleGate = null
    // Deletes may take minutes; stop now and let durable records resume them next launch.
    runQuitTasks('worktree-removals', context)
    // Chat teardown reads background work afterward; clearing status loses subagent/command-only resume offers.
    runQuitTasks('hook-server', context)
    const grokHookCleanup = runQuitTasks('grok-hooks', context)
    // Dispose relay timers and wsl.exe children explicitly rather than rely on pipe teardown.
    runQuitTasks('wsl-relays', context)
    const statsFlush = state.stats?.flushAsync() ?? Promise.resolve()
    // Await per-session close children so browser daemons cannot retain ports/state after quit (#16367); retire headless owners first to avoid duplicate fanout.
    const browserShutdown = (async (): Promise<void> => {
      await state.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
      await state.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
    })()
    // Local SSH browser routes own loopback listeners and ssh -N -D children that must not outlive the app (P2-4).
    const localSshRouteShutdown = runQuitTasks('local-ssh-browser-routes', context)
    runQuitTasks('browser-guests', context)
    const emulatorShutdown =
      state.runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
    const finalStore = state.store
    const beginSshShutdownAndFinalSave = () => {
      // Mark SSH leases detached synchronously immediately before final flush; no await may separate mutation from save.
      const sshShutdown = runQuitTasks('ssh', context)
      runQuitTasks('pty', context)
      const watcherShutdown = shutdownWatchersOnce(context)
      const storeFlush = (async () => {
        if (!finalStore) {
          return
        }
        try {
          await finalStore.flushFinalOrThrowAsync()
          await finalStore.freezeWritesAsync()
          state.profileStateAdmission?.release()
          state.profileStateAdmission = undefined
        } catch (error) {
          console.error('[persistence] Failed to finalize profile state:', error)
        }
      })()
      return { sshShutdown, watcherShutdown, storeFlush }
    }
    // Flush pending pane grids first (bounded at 1s); without one, begin final save synchronously.
    const finalSaves = paneGridFlush
      ? paneGridFlush.then(beginSshShutdownAndFinalSave)
      : beginSshShutdownAndFinalSave()
    const sshShutdown = Promise.resolve(finalSaves).then((saves) => saves.sshShutdown)
    const storeFlush = Promise.resolve(finalSaves).then((saves) => saves.storeFlush)
    const watcherShutdown = Promise.resolve(finalSaves).then((saves) => saves.watcherShutdown)
    // Capture queued usage writes before awaiting teardown or quit can lose the last enabled/scan snapshot.
    const usageCacheFlush = Promise.all([
      state.claudeUsage?.flush(),
      state.codexUsage?.flush(),
      state.openCodeUsage?.flush(),
      state.museUsage?.flush()
    ]).then(() => {})
    runQuitTasks('desktop-browser-bridge', context)
    const browserClientHostShutdown = runQuitTasks('browser-client-hosts', context)
    const skillUploadShutdown = state.runtime?.disposeSkillUploadSessions() ?? Promise.resolve()
    const rpcStopAndClear = state.runtimeRpc
      ? state.runtimeRpc
          .stop()
          .then(() => runQuitTasks('runtime-rpc-stopped', context))
          .catch((error) => console.error('[runtime] Failed to stop local RPC transport:', error))
      : Promise.resolve()
    // After session and RPC teardown, which can still retire notifications; will-quit is past every veto.
    const notificationDismissalClose = Promise.allSettled([
      structuredAgentSessionShutdown,
      rpcStopAndClear
    ]).then(() => state.runtime?.closeNotificationDismissals())
    // Normal quits preserve the detached daemon for warm reattach; dev-parent death leaves its temporary profile ownerless.
    const daemonTeardown = runQuitTasks('daemon', context)
    // Bound unsettled transports and final writes so quit cannot hang (#9447). Failures still exit; atomic swaps preserve old files if the final debounce is lost.
    settleTeardownWithinDeadline([
      { name: 'daemon', promise: daemonTeardown },
      { name: 'browser', promise: browserShutdown },
      { name: 'runtime-rpc', promise: rpcStopAndClear },
      { name: 'watchers', promise: watcherShutdown },
      { name: 'emulator', promise: emulatorShutdown },
      { name: 'browser-client-hosts', promise: browserClientHostShutdown },
      { name: 'local-ssh-browser-routes', promise: localSshRouteShutdown },
      { name: 'ssh', promise: sshShutdown },
      { name: 'plugin-hosts', promise: pluginHostShutdown },
      { name: 'skill-uploads', promise: skillUploadShutdown },
      { name: 'grok-hooks', promise: grokHookCleanup },
      { name: 'ref-maintenance', promise: refMaintenanceShutdown },
      { name: 'codex-backfill-recovery', promise: codexBackfillRecoveryShutdown },
      { name: 'structured-agent-session', promise: structuredAgentSessionShutdown },
      { name: 'usage-cache', promise: usageCacheFlush },
      { name: 'notification-dismissals', promise: notificationDismissalClose },
      { name: 'stats', promise: statsFlush },
      { name: 'state', promise: storeFlush }
    ])
      .then((pendingTeardowns) => {
        if (pendingTeardowns.length > 0) {
          console.warn('[shutdown] Quit teardown deadline reached', { pendingTeardowns })
        }
      })
      .then(() => runQuitTasks('telemetry', context))
      .then(() => runQuitTasks('observability', context))
      .catch(() => {
        /* swallow — telemetry must never prevent app.quit() */
      })
      .then(() => {
        daemonDisconnectDone = true
        app.quit()
      })
  })
}

function installWindowAllClosedHandler(): void {
  app.on('window-all-closed', () => {
    // Keep serve RPC alive after disposable windows close; re-trigger macOS quit after renderer buffer-capture deferral.
    if (
      shouldQuitWhenAllWindowsClosed({
        platform: process.platform,
        isQuitting: state.isQuitting,
        isServeMode: state.isServeMode
      })
    ) {
      app.quit()
    }
  })
}

export function installMainProcessQuitHandlers(): void {
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
