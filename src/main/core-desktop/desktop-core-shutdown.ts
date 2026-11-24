import type { DesktopCore } from './desktop-core'
import type { DesktopCoreProfile } from './desktop-core-startup-failure'
import type { NamedQuitTeardown } from '../startup/quit/quit-teardown-deadline'
import { settleWithinMs } from '../startup/quit/quit-teardown-deadline'
import { killWslChannelsInCloseGrace } from '../wsl/execution/wsl-command-channel'
import { markHostShuttingDown } from '../startup/quit/host-shutdown-state'
import { killAllPty } from '../ipc/pty/provider/kill-all'
import * as daemon from '../daemon/providers/lifecycle/daemon-provider-state'
import { beginSshShutdown } from '../ipc/ssh/ssh-shutdown-drain'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { botToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { wslHookRelayManager } from '../agent-hooks/wsl-relay/wsl-hook-relay-manager'
import { removeManagedAgentHooksAsync } from '../agent-hooks/installation/managed-agent-hook-controls'
import { stopStructuredAgentSessionRuntime } from '../runtime/agent-session/installation/structured-agent-session-runtime'
import { setStructuredAgentSessionTeardownTrigger } from '../runtime/agent-session/installation/structured-agent-session-runtime-teardown'
import { awaitRuntimeFileWatcherUnsubscribes } from '../runtime/files/watch/file-watcher-leases'
import { clearRuntimeMetadataIfOwned } from '../runtime/rpc/server/runtime-metadata'
import { stopCodexStateDbBackfillRecoveries } from '../codex/history/index/codex-state-db-backfill-recovery'
import { stopCodexAccountHistoryWork } from '../codex/history/shared-store/codex-account-history-index'
import { awaitPackedRefsLockRelease } from '../git/refs/maintenance/local-repo-ref-maintenance'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'
import { cancelHistoryGc } from '../pty/history/terminal-history-gc'
import { fenceMainProcessCloudOnQuit } from '../startup/cloud-startup/main-process-connector-startup'
import { ConnectorTurnEvents } from '../connector-cloud/connector-turn-events'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { flushUnsavedCloudSessions } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { getWorkspaceCleanupRunner } from '../workspaces/cleanup/workspace-cleanup-runner-registry'
import { shutdownWatchersOnce } from '../startup/quit/filesystem-watcher-quit-shutdown'

// Config deletion is best effort, not durable state.
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000
// Allow pack-refs time to terminate and unlink its lock.
const REF_MAINTENANCE_QUIT_DEADLINE_MS = 2_000

/** Native steps that sit between core steps today; each runs synchronously at its point. */
export type DesktopCoreShutdownNative = {
  /** Before schedulers, plugins and sessions stop: native observers, diagnostics and tray. */
  afterPushStopped(): void
  /** Before emulator stop and the final save: browser guests, cookies and routes. */
  retireBrowsers(): NamedQuitTeardown[]
  /** After the final-save chain starts: the usage child and paired browser client hosts. */
  stopUsageBackend(): Promise<void> | undefined
  retireBrowserClientHosts(): NamedQuitTeardown[]
  /** Dev-parent death leaves its temporary profile ownerless, so the daemon is shut down instead. */
  isDevParentShutdown(): boolean
}

/** Before-quit: fence new work while a renderer can still veto. `releaseAgentAwake` keeps its place. */
export function fenceDesktopCore(core: DesktopCore, releaseAgentAwake: () => void): void {
  flushUnsavedCloudSessions()
  fenceMainProcessCloudOnQuit()
  core.runtimeRpc?.setMobileRelayPairingProvider(null)
  core.uninstallHookStatusRepublish?.()
  core.uninstallHookStatusRepublish = null
  releaseAgentAwake()
  // Beforeunload may veto; wait for ref locks now but uninstall only after committed quit. isQuitting already blocks new attempts.
  core.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
  // Delay PTY cleanup until scrollback capture; exit events otherwise unmount the renderer callbacks.
  core.rateLimits?.stop()
  // History GC is idempotent and rescheduled next launch; a vetoed quit costs only a deferred sweep.
  cancelHistoryGc()
}

function stopPluginsAndSessions(
  core: DesktopCore,
  trigger: 'update' | 'quit'
): {
  pluginHostShutdown: Promise<void>
  codexBackfillRecoveryShutdown: Promise<unknown>
  structuredAgentSessionShutdown: Promise<unknown>
} {
  // Final stats flush closes working sessions synchronously; quit supplies no terminating hook to preserve their duration.
  core.starNag?.stop()
  core.automations?.stop()
  core.stopTeamPolicyRefresh?.()
  core.stopTeamPolicyRefresh = null
  core.stopTeamPluginPolicy?.()
  core.stopTeamPluginPolicy = null
  if (core.runtime) {
    getWorkspaceCleanupRunner(core.runtime)?.stop()
  }
  // Plugin hosts are forked children; dispose escalates to SIGKILL, and the teardown join keeps Electron from exiting first and orphaning them.
  core.pluginKillListService?.dispose()
  core.pluginKillListService = null
  core.pluginMarketplaceService = null
  core.pluginMarketplaceInstaller = null
  core.pluginAutoUpdater?.dispose()
  core.pluginAutoUpdater = null
  core.pluginUpdateReviewNotices = null
  const pluginHostShutdown = core.pluginService?.dispose() ?? Promise.resolve()
  const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
  stopCodexAccountHistoryWork()
  // Stamp resume reasons before stopping sessions; an update restart was not a user quit.
  setStructuredAgentSessionTeardownTrigger(trigger)
  const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
  core.pluginService = null
  return { pluginHostShutdown, codexBackfillRecoveryShutdown, structuredAgentSessionShutdown }
}

function cleanUpGrokHooksOnWindows(): Promise<void> {
  // Windows bare hook paths lack POSIX ORCA_PANE_KEY guards, so remove Grok hooks on quit; bound cleanup because GROK_HOME can be a stalled network mount.
  if (process.platform !== 'win32') {
    return Promise.resolve()
  }
  return settleWithinMs(
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
}

/**
 * Will-quit: starts every core teardown in today's order and returns its named joins.
 * Final saves wait only for pane grids, paint ledger, removals and the checkpoint; SSH leases are
 * marked detached immediately before the final flush starts, with no await between them.
 */
export function beginDesktopCoreShutdown(
  core: DesktopCore,
  profile: DesktopCoreProfile,
  trigger: 'update' | 'quit',
  native: DesktopCoreShutdownNative
): NamedQuitTeardown[] {
  const runtime = core.runtime
  // Include pane grids still inside their write burst in final save.
  const paneGridFlush = runtime?.flushPaneGrids() ?? null
  // Before the daemon detaches: the next run reads quiet agents' retained frames from it.
  const paintLedgerSave = runtime?.saveReattachedPaintLedger() ?? null
  // A renderer can veto before-quit; push must survive until quit is committed.
  markHostShuttingDown()
  const profileCheckpoint = core.checkpointProfile(profile.store, () => paneGridFlush)
  const removalShutdown = worktreeRemovalLifetime.close()
  const removalQuiescence = removalShutdown.then(
    () => true,
    (error) => {
      console.error('[worktrees] Failed to finish stopping workspace deletion:', error)
      return false
    }
  )
  core.desktopPushService?.stop()
  native.afterPushStopped()
  const feishuShutdown = runtime?.feishuLocal?.stop() ?? Promise.resolve()
  const { pluginHostShutdown, codexBackfillRecoveryShutdown, structuredAgentSessionShutdown } =
    stopPluginsAndSessions(core, trigger)
  // Wait briefly for ref maintenance instead of killing mid-prune and stranding its lock; an orphan can finish safely.
  const refMaintenanceShutdown = settleWithinMs(
    Promise.all([core.repoMaintenanceShutdown, core.uninstallRepoMaintenanceIdleGate?.()]).then(
      () => {}
    ),
    REF_MAINTENANCE_QUIT_DEADLINE_MS
  ).then(() => {})
  core.uninstallRepoMaintenanceIdleGate = null
  // Chat teardown reads background work afterward; clearing status loses subagent/command-only resume offers.
  agentHookServer.stop({ keepStatus: true })
  botToolRelay.close()
  const grokHookCleanup = cleanUpGrokHooksOnWindows()
  // Dispose relay timers and wsl.exe children explicitly rather than rely on pipe teardown.
  wslHookRelayManager.disposeAll()
  // A closed WSL-host channel still in its EOF grace must not outlive the app.
  killWslChannelsInCloseGrace()
  const statsFlush = core.stats?.flushAsync() ?? Promise.resolve()
  // The connector was fenced at before-quit; its last turn ends and memory history rows land now.
  const connectorTurnEndsFlush = ConnectorTurnEvents.settled()
  const botMemoryHistoryFlush = runtime?.bots.memory.historySettled() ?? Promise.resolve()
  const browserJoins = native.retireBrowsers()
  const emulatorShutdown = runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
  const finalStore = profile.store
  const beginSshShutdownAndFinalSave = (removalStopped: boolean) => {
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
        if (removalStopped) {
          profile.releaseAdmission()
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
    paintLedgerSave,
    removalQuiescence,
    profileCheckpoint.catch(() => {})
  ]).then(([, , stopped]) => beginSshShutdownAndFinalSave(stopped))
  const sshShutdown = finalSaves.then((saves) => saves.sshShutdown)
  const storeFlush = finalSaves.then((saves) => saves.storeFlush)
  const watcherShutdown = finalSaves.then((saves) => saves.watcherShutdown)
  const usageCacheFlush = Promise.all([
    native.stopUsageBackend(),
    core.usageWorktreeHistory?.flush()
  ]).then(() => {})
  const browserClientHostJoins = native.retireBrowserClientHosts()
  const skillUploadShutdown = runtime?.disposeSkillUploadSessions() ?? Promise.resolve()
  // Capture ownership before awaits let other teardown paths clear runtime state.
  const ownedPid = process.pid
  const ownedRuntimeId = runtime?.getRuntimeId()
  const rpcStopAndClear = core.runtimeRpc
    ? core.runtimeRpc
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
  ]).then(() => runtime?.closeNotificationDismissals())
  // Normal quits preserve the detached daemon for warm reattach.
  const daemonTeardown = removalQuiescence.then(() =>
    native.isDevParentShutdown() ? daemon.shutdownDaemon() : daemon.disconnectDaemon()
  )
  return [
    { name: 'worktree-removals', promise: removalShutdown },
    { name: 'state-checkpoint', promise: profileCheckpoint },
    { name: 'daemon', promise: daemonTeardown },
    ...browserJoins,
    { name: 'runtime-rpc', promise: rpcStopAndClear },
    { name: 'watchers', promise: watcherShutdown },
    { name: 'emulator', promise: emulatorShutdown },
    ...browserClientHostJoins,
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
    { name: 'feishu-local', promise: feishuShutdown },
    { name: 'connector-turn-ends', promise: connectorTurnEndsFlush },
    { name: 'bot-memory-history', promise: botMemoryHistoryFlush },
    { name: 'state', promise: storeFlush }
  ]
}
