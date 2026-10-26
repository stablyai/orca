import { app, type Event } from 'electron'
import { closeAllWatchers } from '../ipc/filesystem/watchers/filesystem-watcher-shutdown'
import { disposeWorktreeBaseDirectoryWatchers } from '../ipc/worktree-base-directory-watcher'
import { stopFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import { killAllPty } from '../ipc/pty/kill-all'
import { disconnectDaemon, shutdownDaemon } from '../daemon/daemon-provider-state'
import { beginSshShutdown } from '../ipc/ssh/ssh-shutdown-drain'
import { agentHookServer } from '../agent-hooks/server'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { removeManagedAgentHooksAsync } from '../agent-hooks/managed-agent-hook-controls'
import { stopStructuredAgentSessionRuntime } from '../runtime/structured-agent-session-runtime'
import { setStructuredAgentSessionTeardownTrigger } from '../runtime/agent-session/structured-agent-session-runtime-teardown'
import { awaitRuntimeFileWatcherUnsubscribes } from '../runtime/files/watch/file-watcher-leases'
import { clearRuntimeMetadataIfOwned } from '../runtime/runtime-metadata'
import { shutdownPairedRuntimeBrowserClientHosts } from '../browser/paired-runtime-browser-client-host-runtime'
import { disposeDesktopBrowserBridge } from '../ipc/desktop-browser-bridge-wiring'
import { browserManager } from '../browser/browser-manager'
import { stopCodexStateDbBackfillRecoveries } from '../codex/codex-state-db-backfill-recovery'
import { stopCodexAccountSessionBridges } from '../codex/codex-account-session-bridge'
import { awaitPackedRefsLockRelease } from '../git/local-repo-ref-maintenance'
import { stopBackgroundWorktreeRemovals } from '../worktree-background-removal'
import { settleTeardownWithinDeadline, settleWithinMs } from '../quit-teardown-deadline'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { setUnreadDockBadgeCount } from '../dock/unread-badge'
import { destroySystemTray } from '../tray/system-tray'
import { shutdownTelemetry } from '../telemetry/client'
import { shutdownObservability } from '../observability'
import { isQuittingForUpdate } from '../updater'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { stopTccPromptNotice } from '../macos-tcc-prompt-notice'
import { cancelHistoryGc } from '../terminal-history-gc'
import { shouldQuitWhenAllWindowsClosed } from './window-all-closed-quit-policy'
import { mainProcessState as state } from './main-process-state'
import { isDevParentShutdownRequested } from './configure-process'
import { getCanonicalUserDataPath } from '../persistence'
import { flushUnsavedCloudSessions } from '../orca-profiles/profile-cloud-session-owner'

// First will-quit pass awaits teardown; the re-fired pass must exit without starting writes again.
let daemonDisconnectDone = false
let watcherShutdownPromise: Promise<void> | null = null
// Config deletion is best effort, not durable state.
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000
// Allow pack-refs time to terminate and unlink its lock.
const REF_MAINTENANCE_QUIT_DEADLINE_MS = 2_000

function shutdownWatchersOnce(): Promise<void> {
  if (state.watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Await native watcher unsubscribe before Node environment teardown.
    stopFolderRepoGitUpgradeWatch()
    watcherShutdownPromise = Promise.allSettled([
      closeAllWatchers(),
      disposeWorktreeBaseDirectoryWatchers()
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
    if (isQuittingForUpdate()) {
      recordUpdaterLifecycle('before_quit_allowed', undefined, {
        message: 'before-quit allowed for update install'
      })
    }
    state.isQuitting = true
    flushUnsavedCloudSessions()
    state.desktopRelayService?.fenceAndCloseNow()
    state.runtimeRpc?.setMobileRelayPairingProvider(null)
    state.unsubscribeAgentAwakeStatusChanges?.()
    state.unsubscribeAgentAwakeStatusChanges = null
    state.agentAwakeService?.dispose()
    state.agentAwakeService = null
    // Beforeunload may veto; wait for ref locks now but uninstall only after committed quit. isQuitting already blocks new attempts.
    state.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
    // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
    state.rateLimits?.stop()
    // History GC is idempotent and rescheduled next launch; a vetoed quit costs only a deferred sweep.
    cancelHistoryGc()
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
    // Include pane grids still inside their write burst in final save.
    const paneGridFlush = state.runtime?.flushPaneGrids() ?? null
    // A renderer can veto before-quit; push must survive until quit is committed.
    state.desktopPushService?.stop()
    state.unsubscribeSystemResumeBroadcast?.()
    state.unsubscribeSystemResumeBroadcast = null
    state.stopDesktopPresenceReporter?.()
    state.stopDesktopPresenceReporter = null
    // Keep log-stream diagnostics alive through renderer quit vetoes.
    stopTccPromptNotice()
    const updateQuitInProgress = isQuittingForUpdate()
    if (updateQuitInProgress) {
      recordUpdaterLifecycle(
        'will_quit_cleanup_started',
        { daemonTeardown: 'disconnect' },
        { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
      )
    }
    // Remove the Windows tray icon only after renderer vetoes are past.
    destroySystemTray()
    // Final stats flush closes working sessions synchronously; quit supplies no terminating hook to preserve their duration.
    state.starNag?.stop()
    state.automations?.stop()
    // Await plugin shutdown/SIGKILL escalation or forked hosts can outlive Electron.
    state.pluginKillListService = null
    state.pluginMarketplaceService = null
    state.pluginMarketplaceInstaller = null
    const pluginHostShutdown = state.pluginService?.dispose() ?? Promise.resolve()
    const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
    stopCodexAccountSessionBridges()
    // Stamp resume reasons before stopping sessions; an update restart was not a user quit.
    setStructuredAgentSessionTeardownTrigger(updateQuitInProgress ? 'update' : 'quit')
    const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
    state.pluginService = null
    setUnreadDockBadgeCount(0)
    // Wait briefly for ref maintenance instead of killing mid-prune and stranding its lock; an orphan can finish safely.
    const refMaintenanceShutdown = settleWithinMs(
      Promise.all([state.repoMaintenanceShutdown, state.uninstallRepoMaintenanceIdleGate?.()]).then(
        () => {}
      ),
      REF_MAINTENANCE_QUIT_DEADLINE_MS
    ).then(() => {})
    state.uninstallRepoMaintenanceIdleGate = null
    // Deletes may take minutes; stop now and let durable records resume them next launch.
    stopBackgroundWorktreeRemovals()
    // Chat teardown reads background work afterward; clearing status loses subagent/command-only resume offers.
    agentHookServer.stop({ keepStatus: true })
    // Windows bare hook paths lack POSIX ORCA_PANE_KEY guards, so remove Grok hooks on quit; bound cleanup because GROK_HOME can be a stalled network mount.
    const grokHookCleanup =
      process.platform === 'win32'
        ? settleWithinMs(
            removeManagedAgentHooksAsync({ agents: ['grok'] }),
            GROK_HOOK_CLEANUP_DEADLINE_MS
          ).then((settled) => {
            if (settled.outcome === 'timed-out') {
              console.warn('[agent-hooks] Grok hook cleanup on quit timed out')
              return
            }
            if (settled.outcome === 'failed') {
              console.warn('[agent-hooks] Grok hook cleanup on quit failed:', settled.error)
              return
            }
            // Removal failures can be fulfilled status results; inspect their detail too.
            for (const status of settled.value.filter((entry) => entry.detail)) {
              console.warn(`[agent-hooks] ${status.agent} hook cleanup on quit: ${status.detail}`)
            }
          })
        : Promise.resolve()
    // Dispose relay timers and wsl.exe children explicitly rather than rely on pipe teardown.
    wslHookRelayManager.disposeAll()
    const statsFlush = state.stats?.flushAsync() ?? Promise.resolve()
    // Await per-session close children so browser daemons cannot retain ports/state after quit (#16367); retire headless owners first to avoid duplicate fanout.
    const browserShutdown = (async (): Promise<void> => {
      await state.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
      await state.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
    })()
    // Local SSH browser routes own loopback listeners and ssh -N -D children that must not outlive the app (P2-4).
    const localSshRouteShutdown = import('../browser/local-ssh-browser-route')
      .then((routes) => routes.closeAllLocalSshBrowserRoutes())
      .catch(() => {})
    browserManager.setBrowserGuestStateChangedListener(null)
    const emulatorShutdown =
      state.runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
    const finalStore = state.store
    const beginSshShutdownAndFinalSave = () => {
      // Mark SSH leases detached synchronously immediately before final flush; no await may separate mutation from save.
      const sshShutdown = beginSshShutdown()
      killAllPty()
      const watcherShutdown = shutdownWatchersOnce()
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
    disposeDesktopBrowserBridge()
    const browserClientHostShutdown = shutdownPairedRuntimeBrowserClientHosts()
    const skillUploadShutdown = state.runtime?.disposeSkillUploadSessions() ?? Promise.resolve()
    // Capture ownership before awaits let other teardown paths clear runtime state.
    const ownedPid = process.pid
    const ownedRuntimeId = state.runtime?.getRuntimeId()
    const rpcStopAndClear = state.runtimeRpc
      ? state.runtimeRpc
          .stop()
          .then(() => awaitRuntimeFileWatcherUnsubscribes())
          .then(() => {
            if (ownedRuntimeId) {
              // Match the runtime writer's canonical metadata path, not late app.getPath.
              clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => console.error('[runtime] Failed to stop local RPC transport:', error))
      : Promise.resolve()
    // After session and RPC teardown, which can still retire notifications; will-quit is past every veto.
    const notificationDismissalClose = Promise.allSettled([
      structuredAgentSessionShutdown,
      rpcStopAndClear
    ]).then(() => state.runtime?.closeNotificationDismissals())
    // Normal quits preserve the detached daemon for warm reattach; dev-parent death leaves its temporary profile ownerless.
    const daemonTeardown = isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()
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
      .then(() => shutdownTelemetry())
      .then(() => shutdownObservability())
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
  // app.exit skips Electron quit events; stop the log child on forced exits too.
  process.once('exit', stopTccPromptNotice)
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
