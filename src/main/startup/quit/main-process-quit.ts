import { closeEnvironmentStore } from '../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import { beginProfileShutdownCheckpoint } from '../../persistence/profile-shutdown-checkpoint'
import { killWslChannelsInCloseGrace } from '../../wsl/execution/wsl-command-channel'
import { markHostShuttingDown } from './host-shutdown-state'
import { app, type Event } from 'electron'
import { killAllPty } from '../../ipc/pty/provider/kill-all'
import * as daemon from '../../daemon/providers/lifecycle/daemon-provider-state'
import { beginSshShutdown } from '../../ipc/ssh/ssh-shutdown-drain'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { botToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { wslHookRelayManager } from '../../agent-hooks/wsl-relay/wsl-hook-relay-manager'
import { removeManagedAgentHooksAsync } from '../../agent-hooks/installation/managed-agent-hook-controls'
import { stopStructuredAgentSessionRuntime } from '../../runtime/agent-session/installation/structured-agent-session-runtime'
import { setStructuredAgentSessionTeardownTrigger } from '../../runtime/agent-session/installation/structured-agent-session-runtime-teardown'
import { awaitRuntimeFileWatcherUnsubscribes } from '../../runtime/files/watch/file-watcher-leases'
import { clearRuntimeMetadataIfOwned } from '../../runtime/rpc/server/runtime-metadata'
import { shutdownPairedRuntimeBrowserClientHosts } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { disposeDesktopBrowserBridge } from '../../ipc/browser/desktop-browser-bridge-wiring'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { stopCodexStateDbBackfillRecoveries } from '../../codex/history/index/codex-state-db-backfill-recovery'
import { stopCodexAccountHistoryWork } from '../../codex/history/shared-store/codex-account-history-index'
import { awaitPackedRefsLockRelease } from '../../git/refs/maintenance/local-repo-ref-maintenance'
import { worktreeRemovalLifetime } from '../../workspaces/removal/worktree-removal-lifetime'
import { settleTeardownWithinDeadline, settleWithinMs } from './quit-teardown-deadline'
import { quitTeardownStartGate } from './quit-teardown-start-gate'
import { setUnreadDockBadgeCount } from '../../dock/unread-badge'
import { destroySystemTray } from '../../tray/system-tray'
import { shutdownTelemetry } from '../../telemetry/client'
import { shutdownObservability } from '../../observability/index'
import { isQuittingForUpdate } from '../../updater/updater-service'
import { recordUpdaterLifecycle } from '../../updater/updater-lifecycle-diagnostics'
import { pendingServeSupervisorQuitCommit } from '../../updater/lifecycle/serve-supervisor-install-park'
import { stopTccPromptNotice } from '../../macos-permissions/macos-tcc-prompt-notice'
import { cancelHistoryGc } from '../../pty/history/terminal-history-gc'
import { installWindowAllClosedHandler } from './window-all-closed-quit-handler'
import { fenceMainProcessCloudOnQuit } from '../cloud-startup/main-process-connector-startup'
import { ConnectorTurnEvents } from '../../connector-cloud/connector-turn-events'
import { mainProcessState as state } from '../main-process-state'
import { isDevParentShutdownRequested } from '../configure-process'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { flushUnsavedCloudSessions } from '../../orca-profiles/cloud-session/profile-cloud-session-owner'
import { getWorkspaceCleanupRunner } from '../../workspaces/cleanup/workspace-cleanup-runner-registry'
import { closeBrowserExtensionProfileDocumentStores } from '../../browser/extensions/profile-storage/browser-extension-profile-document-store'
import { closeBrowserExtensionProfileStateStore } from '../../browser/extensions/profile-storage/browser-extension-profile-state-store'
import { shutdownWatchersOnce } from './filesystem-watcher-quit-shutdown'
import { flushBrowserSessionCookiesOnQuit } from '../../browser/cookies/session-restore/browser-session-cookie-restore'
let daemonDisconnectDone = false
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000
const REF_MAINTENANCE_QUIT_DEADLINE_MS = 2_000

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
    fenceMainProcessCloudOnQuit()
    state.runtimeRpc?.setMobileRelayPairingProvider(null)
    state.unsubscribeAgentAwakeStatusChanges?.()
    state.unsubscribeAgentAwakeStatusChanges = null
    state.agentAwakeService?.dispose()
    state.agentAwakeService = null
    state.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
    // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
    state.rateLimits?.stop()
    cancelHistoryGc()
  })
}
function installWillQuitHandler(): void {
  app.on('will-quit', (event: Event) => {
    // The second pass must not start fresh writes that process exit would interrupt.
    if (daemonDisconnectDone) {
      return
    }
    // Prevent exit before awaiting work; the deadline timer needs this thread.
    if (!quitTeardownStartGate.tryStart(event)) {
      return
    }
    const cloudSessionFlush = flushUnsavedCloudSessions()
    const paneGridFlush = state.runtime?.flushPaneGrids() ?? null
    markHostShuttingDown()
    state.profileShutdownCheckpoint ??= beginProfileShutdownCheckpoint(state.store, paneGridFlush)
    const removalShutdown = worktreeRemovalLifetime.close()
    const removalQuiescence = removalShutdown.then(
      () => true,
      (error) => {
        console.error('[worktrees] Failed to finish stopping workspace deletion:', error)
        return false
      }
    )
    state.desktopPushService?.stop()
    state.unsubscribeSystemResumeBroadcast?.()
    state.unsubscribeSystemResumeBroadcast = null
    state.unsubscribeWakeSignalClock?.()
    state.unsubscribeWakeSignalClock = null
    state.stopDesktopPresenceReporter?.()
    state.stopDesktopPresenceReporter = null
    stopTccPromptNotice()
    const updateQuitInProgress = isQuittingForUpdate()
    if (updateQuitInProgress) {
      recordUpdaterLifecycle(
        'will_quit_cleanup_started',
        { daemonTeardown: 'disconnect' },
        { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
      )
    }
    destroySystemTray()
    state.starNag?.stop()
    state.automations?.stop()
    if (state.runtime) {
      getWorkspaceCleanupRunner(state.runtime)?.stop()
    }
    state.pluginKillListService?.dispose()
    state.pluginKillListService = null
    state.pluginMarketplaceService = null
    state.pluginMarketplaceInstaller = null
    state.pluginAutoUpdater?.dispose()
    state.pluginAutoUpdater = null
    state.pluginUpdateReviewNotices = null
    const pluginHostShutdown = state.pluginService?.dispose() ?? Promise.resolve()
    const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
    stopCodexAccountHistoryWork()
    setStructuredAgentSessionTeardownTrigger(updateQuitInProgress ? 'update' : 'quit')
    const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
    state.pluginService = null
    setUnreadDockBadgeCount(0)
    const refMaintenanceShutdown = settleWithinMs(
      Promise.all([state.repoMaintenanceShutdown, state.uninstallRepoMaintenanceIdleGate?.()]).then(
        () => {}
      ),
      REF_MAINTENANCE_QUIT_DEADLINE_MS
    ).then(() => {})
    state.uninstallRepoMaintenanceIdleGate = null
    agentHookServer.stop({ keepStatus: true })
    botToolRelay.close()
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
            for (const status of settled.value.filter((entry) => entry.detail)) {
              console.warn(`[agent-hooks] ${status.agent} hook cleanup on quit: ${status.detail}`)
            }
          })
        : Promise.resolve()
    wslHookRelayManager.disposeAll()
    killWslChannelsInCloseGrace()
    const statsFlush = state.stats?.flushAsync() ?? Promise.resolve()
    const connectorTurnEndsFlush = ConnectorTurnEvents.settled()
    const botMemoryHistoryFlush = state.runtime?.bots.memory.historySettled() ?? Promise.resolve()
    const browserSessionCookieFlush = flushBrowserSessionCookiesOnQuit()
    const browserShutdown = (async (): Promise<void> => {
      await state.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
      await state.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
    })()
    const localSshRouteShutdown =
      import('../../browser/routing/local-host-partitions/local-ssh-browser-route')
        .then((routes) => routes.closeAllLocalSshBrowserRoutes())
        .catch(() => {})
    browserManager.setBrowserGuestStateChangedListener(null)
    browserManager.setOffscreenTabOpener(null)
    const emulatorShutdown =
      state.runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
    const finalStore = state.store
    const beginSshShutdownAndFinalSave = (removalStopped: boolean) => {
      // Mark SSH leases detached immediately before the final save.
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
          if (removalStopped) {
            state.profileStateAdmission?.release()
            state.profileStateAdmission = undefined
          }
        } catch (error) {
          console.error('[persistence] Failed to finalize profile state:', error)
        }
      })()
      return { sshShutdown, watcherShutdown, storeFlush }
    }
    // Removal writers and pending pane grids must settle before the profile freezes.
    const finalSaves = Promise.all([
      paneGridFlush,
      removalQuiescence,
      state.profileShutdownCheckpoint.catch(() => {})
    ]).then(([, stopped]) => beginSshShutdownAndFinalSave(stopped))
    const sshShutdown = Promise.resolve(finalSaves).then((saves) => saves.sshShutdown)
    const storeFlush = Promise.resolve(finalSaves).then((saves) => saves.storeFlush)
    const watcherShutdown = Promise.resolve(finalSaves).then((saves) => saves.watcherShutdown)
    const usageCacheFlush = Promise.all([
      state.backend?.stop(),
      state.usageWorktreeHistory?.flush()
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
              clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => console.error('[runtime] Failed to stop local RPC transport:', error))
      : Promise.resolve()
    const notificationDismissalClose = Promise.allSettled([
      structuredAgentSessionShutdown,
      rpcStopAndClear
    ]).then(() => state.runtime?.closeNotificationDismissals())
    const daemonTeardown = removalQuiescence.then(() =>
      isDevParentShutdownRequested() ? daemon.shutdownDaemon() : daemon.disconnectDaemon()
    )
    // Bound transports and final writes so quit cannot hang (#9447).
    const teardowns = [
      { name: 'cloud-sessions', promise: cloudSessionFlush },
      { name: 'worktree-removals', promise: removalShutdown },
      { name: 'install-park', promise: pendingServeSupervisorQuitCommit() },
      { name: 'state-checkpoint', promise: state.profileShutdownCheckpoint },
      { name: 'daemon', promise: daemonTeardown },
      { name: 'browser', promise: browserShutdown },
      { name: 'browser-session-cookies', promise: browserSessionCookieFlush },
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
      { name: 'connector-turn-ends', promise: connectorTurnEndsFlush },
      { name: 'bot-memory-history', promise: botMemoryHistoryFlush },
      { name: 'state', promise: storeFlush }
    ]
    const teardownSettlement = Promise.allSettled(teardowns.map((item) => item.promise))
    settleTeardownWithinDeadline([
      ...teardowns,
      { name: 'environment-store', promise: teardownSettlement.then(closeEnvironmentStore) }
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
      .then(() =>
        Promise.all([
          closeBrowserExtensionProfileDocumentStores(),
          closeBrowserExtensionProfileStateStore()
        ])
      )
      .then(() => {
        daemonDisconnectDone = true
        app.quit()
      })
  })
}

export function installMainProcessQuitHandlers(): void {
  // app.exit skips Electron quit events; stop the log child on forced exits too.
  process.once('exit', stopTccPromptNotice)
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
