import { app, type Event } from 'electron'
import { closeAllWatchers } from '../ipc/filesystem-watcher'
import { disposeWorktreeBaseDirectoryWatchers } from '../ipc/worktree-base-directory-watcher'
import { stopFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import { killAllPty } from '../ipc/pty'
import { disconnectDaemon, shutdownDaemon } from '../daemon/daemon-init'
import { beginSshShutdown } from '../ipc/ssh-shutdown-drain'
import { agentHookServer } from '../agent-hooks/server'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { removeManagedAgentHooksAsync } from '../agent-hooks/managed-agent-hook-controls'
import { stopStructuredAgentSessionRuntime } from '../runtime/structured-agent-session-runtime'
import { awaitRuntimeFileWatcherUnsubscribes } from '../runtime/orca-runtime-files'
import { clearRuntimeMetadataIfOwned } from '../runtime/runtime-metadata'
import { shutdownPairedRuntimeBrowserClientHosts } from '../browser/paired-runtime-browser-client-host-runtime'
import { browserManager } from '../browser/browser-manager'
import { stopCodexStateDbBackfillRecoveries } from '../codex/codex-state-db-backfill-recovery'
import { awaitPackedRefsLockRelease } from '../git/local-repo-ref-maintenance'
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

// Why: will-quit fires twice — first pass preventDefaults and runs teardown; second pass exits.
let daemonDisconnectDone = false
let watcherShutdownPromise: Promise<void> | null = null
// Why 2s: a config delete is best-effort, not durable state.
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000
// Why 2s: long enough for a `pack-refs` child to take SIGTERM and unlink its lock.
const REF_MAINTENANCE_QUIT_DEADLINE_MS = 2_000

function shutdownWatchersOnce(): Promise<void> {
  if (state.watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Why: @parcel/watcher tears down native async work on unsubscribe; Electron must await it before Node's environment exits.
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
  app.on('before-quit', () => {
    if (isQuittingForUpdate()) {
      recordUpdaterLifecycle('before_quit_allowed', undefined, {
        message: 'before-quit allowed for update install'
      })
    }
    state.isQuitting = true
    state.desktopRelayService?.fenceAndCloseNow()
    state.runtimeRpc?.setMobileRelayPairingProvider(null)
    state.unsubscribeAgentAwakeStatusChanges?.()
    state.unsubscribeAgentAwakeStatusChanges = null
    state.agentAwakeService?.dispose()
    state.agentAwakeService = null
    // Why wait but not uninstall: a renderer beforeunload can still veto this
    // quit, and tearing the sweep down here would kill it for the rest of the
    // session. `isQuitting` already vetoes new attempts; will-quit does the teardown.
    state.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
    // Why: defer PTY cleanup to will-quit so the renderer captures scrollback before PTY-exit events unmount TerminalPane (dropping its capture callbacks).
    state.rateLimits?.stop()
    // Why safe on a vetoed quit: background history GC is idempotent and re-scheduled next launch,
    // so abandoning the walk here only costs one deferred sweep, never a half-applied prune.
    cancelHistoryGc()
  })
}

function installWillQuitHandler(): void {
  app.on('will-quit', (event: Event) => {
    // Why return instead of re-running teardown: the second pass is Electron re-firing after
    // our own app.quit(), so every step below already ran and every durable write already
    // landed. Re-entering would start a fresh unawaited write that the exit then tears down.
    if (daemonDisconnectDone) {
      return
    }
    // Why preventDefault before any work: everything below must be free to await, and a
    // synchronous durable write here parks the main thread — uninterruptibly, on a stalled
    // network profile mount. The teardown deadline cannot rescue that, because its timer
    // lives on the same thread it would need to bound (#9447 covers the wedged-transport
    // half; this covers the blocked-syscall half).
    if (!quitTeardownStartGate.tryStart(event)) {
      return
    }
    state.unsubscribeSystemResumeBroadcast?.()
    state.unsubscribeSystemResumeBroadcast = null
    // Why: renderer guards can still cancel before this committed phase; `log stream` must survive those vetoes.
    stopTccPromptNotice()
    const updateQuitInProgress = isQuittingForUpdate()
    if (updateQuitInProgress) {
      recordUpdaterLifecycle(
        'will_quit_cleanup_started',
        { daemonTeardown: 'disconnect' },
        { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
      )
    }
    // Why: before-quit can still be aborted by renderer beforeunload; only remove the Windows tray icon on the committed quit path.
    destroySystemTray()
    // Why: an agent still working at quit gets no terminating hook, so stats.flushAsync() closes those sessions out synchronously (only the write is deferred) — otherwise their duration is lost.
    state.starNag?.stop()
    state.automations?.stop()
    // Why: plugin hosts are forked children; dispose sends shutdown and
    // escalates to SIGKILL so they cannot outlive the app. The promise joins
    // the teardown barrier below — quitting before it resolves would let
    // Electron exit first and orphan the hosts.
    state.pluginKillListService = null
    state.pluginMarketplaceService = null
    state.pluginMarketplaceInstaller = null
    const pluginHostShutdown = state.pluginService?.dispose() ?? Promise.resolve()
    const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
    const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
    state.pluginService = null
    setUnreadDockBadgeCount(0)
    // Why wait rather than kill: the child finishes fine orphaned, and signalling
    // it mid-prune strands a ref lock Git never clears. The wait is only for the
    // short rewrite window, and is bounded so a quit can never hang on it.
    const refMaintenanceShutdown = settleWithinMs(
      Promise.all([state.repoMaintenanceShutdown, state.uninstallRepoMaintenanceIdleGate?.()]).then(
        () => {}
      ),
      REF_MAINTENANCE_QUIT_DEADLINE_MS
    ).then(() => {})
    state.uninstallRepoMaintenanceIdleGate = null
    agentHookServer.stop()
    // Why Windows only: POSIX hooks short-circuit on ORCA_PANE_KEY, while Windows must register a
    // bare script path that cannot express the guard and would otherwise keep spawning after quit.
    // Why bounded here: every other teardown member carries its own ceiling, and this one reaches
    // $GROK_HOME -- which can be a stalled network mount, where the fs calls never settle and the
    // shared 20s deadline becomes the only thing ending the quit.
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
            // Why: removers report failures as statuses, so inspect details even after fulfillment.
            for (const status of settled.value.filter((entry) => entry.detail)) {
              console.warn(`[agent-hooks] ${status.agent} hook cleanup on quit: ${status.detail}`)
            }
          })
        : Promise.resolve()
    // Why: cancels relay restart/reinstall timers and kills wsl.exe children deterministically, not via stdio-pipe teardown.
    wslHookRelayManager.disposeAll()
    const statsFlush = state.stats?.flushAsync() ?? Promise.resolve()
    // Why: agent-browser daemon processes would otherwise linger after quit, holding ports and stale session state on disk.
    // Why the barrier below: each session's close is its own agent-browser child taking hundreds of ms,
    // so an unawaited call reaches app.quit() first and every open tab's daemon survives the quit (#16367).
    // Why retire headless page owners first: it closes those helpers without a duplicate close fanout.
    const browserShutdown = (async (): Promise<void> => {
      await state.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
      await state.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
    })()
    // Why (review P2-4): local SSH browser routes own loopback listeners and, on the
    // system-ssh path, `ssh -N -D` children that would otherwise outlive the app.
    const localSshRouteShutdown = import('../browser/local-ssh-browser-route')
      .then((routes) => routes.closeAllLocalSshBrowserRoutes())
      .catch(() => {})
    browserManager.setBrowserGuestStateChangedListener(null)
    const emulatorShutdown =
      state.runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
    // Why immediately before store.flushAsync() with no await in between: beginSshShutdown() marks every
    // active SSH lease detached in memory synchronously, and that flush is what persists it.
    const sshShutdown = beginSshShutdown()
    killAllPty()
    const watcherShutdown = shutdownWatchersOnce()
    const storeFlush = state.store?.flushAsync() ?? Promise.resolve()
    // Why: usage-cache writes are queued off the main thread, so a quit right after setEnabled or a
    // scan completion would drop the final snapshot. Captured before any await; joins the barrier below.
    const usageCacheFlush = Promise.all([
      state.claudeUsage?.flush(),
      state.codexUsage?.flush(),
      state.openCodeUsage?.flush()
    ]).then(() => {})
    const browserClientHostShutdown = shutdownPairedRuntimeBrowserClientHosts()
    const skillUploadShutdown = state.runtime?.disposeSkillUploadSessions() ?? Promise.resolve()
    // Why: capture pid/runtimeId synchronously (before any await) so a later teardown path can't null them out mid-chain.
    const ownedPid = process.pid
    const ownedRuntimeId = state.runtime?.getRuntimeId()
    const rpcStopAndClear = state.runtimeRpc
      ? state.runtimeRpc
          .stop()
          .then(() => awaitRuntimeFileWatcherUnsubscribes())
          .then(() => {
            if (ownedRuntimeId) {
              // Why: must match the path the runtime server wrote metadata to (getCanonicalUserDataPath), not late app.getPath('userData').
              clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => console.error('[runtime] Failed to stop local RPC transport:', error))
      : Promise.resolve()
    // Why: allSettled (not all) keeps fail-open — a daemon-disconnect rejection still quits instead of hanging.
    // Why: telemetry flush folds in before app.quit() (bounded 2s); catch defensively so a flush failure can't cancel the quit chain.
    // Why: normal quits keep the detached daemon for warm reattach, but a dead dev parent leaves the temp/dev profile ownerless.
    const daemonTeardown = isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()
    // Why: a wedged transport (half-open post-sleep socket) can leave one
    // member unsettled forever and block app.quit() until Force Quit (#9447).
    // Why stats/state join here: their writes are durable but not worth hanging the app for.
    // Losing at most the last debounce interval beats a quit that never completes, and the
    // temp+rename swap means a write cut short by the deadline leaves the old file intact.
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
    // Why: serve mode / disposable offscreen browser windows must not take down runtime RPC — the policy fn keeps the app alive.
    // Why: on macOS a quit-in-progress (Cmd+Q) is canceled by the renderer buffer-capture deferral; re-trigger quit so it actually exits.
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

/** Installs the process-level shutdown listeners once during bootstrap. */
export function installMainProcessQuitHandlers(): void {
  // Why: app.exit() skips Electron quit events, so keep its log child from surviving forced exits.
  process.once('exit', stopTccPromptNotice)
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
