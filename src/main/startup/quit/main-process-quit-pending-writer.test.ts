import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/quit-teardown-deadline'
import type { DaemonKillAllResult } from '../../ipc/pty/pty-management'

const settled = () => vi.fn(async () => {})
const idle = () => vi.fn()
const stopAgentHookServer = idle()
const stopStructuredAgentSessionRuntime = settled()
const beginSshShutdown = settled()
const killAllPty = idle()
const disconnectDaemon = settled()
const killAllDaemonSessions = vi.fn<() => Promise<DaemonKillAllResult>>(async () => ({
  killedCount: 0,
  remainingCount: 0,
  killedSessionIds: []
}))

// Every teardown member settles except the profile store, so only the writer can hold quit.
const dependencies: Record<string, Record<string, unknown>> = {
  '../../ipc/filesystem/watchers/filesystem-watcher-shutdown': { closeAllWatchers: settled() },
  '../../ipc/worktrees/creation/worktree-base-directory-watcher': {
    disposeWorktreeBaseDirectoryWatchers: settled()
  },
  '../../ipc/folder-repo-git-upgrade': { stopFolderRepoGitUpgradeWatch: idle() },
  '../../ipc/pty/kill-all': { killAllPty },
  '../../ipc/pty/pty-management': { killAllDaemonSessions },
  '../../daemon/providers/lifecycle/daemon-provider-state': {
    disconnectDaemon,
    shutdownDaemon: settled()
  },
  './app-relaunch': { isAppRelaunchRequested: () => false },
  '../../ipc/ssh/ssh-shutdown-drain': { beginSshShutdown },
  '../cloud-startup/main-process-connector-startup': { desktopConnectorCloud: () => null },
  '../../agent-hooks/server/agent-hook-server': { agentHookServer: { stop: stopAgentHookServer } },
  '../../agent-hooks/wsl-relay/wsl-hook-relay-manager': {
    wslHookRelayManager: { disposeAll: idle() }
  },
  '../../agent-hooks/installation/managed-agent-hook-controls': {
    removeManagedAgentHooksAsync: vi.fn(async () => [])
  },
  '../../runtime/agent-session/structured-agent-session-runtime': {
    stopStructuredAgentSessionRuntime
  },
  '../../runtime/agent-session/structured-agent-session-runtime-teardown': {
    setStructuredAgentSessionTeardownTrigger: idle()
  },
  '../../runtime/files/watch/file-watcher-leases': {
    awaitRuntimeFileWatcherUnsubscribes: settled()
  },
  '../../runtime/rpc/server/runtime-metadata': { clearRuntimeMetadataIfOwned: idle() },
  '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime': {
    shutdownPairedRuntimeBrowserClientHosts: settled()
  },
  '../../ipc/browser/desktop-browser-bridge-wiring': { disposeDesktopBrowserBridge: idle() },
  '../../orca-profiles/cloud-session/profile-cloud-session-owner': {
    flushUnsavedCloudSessions: idle()
  },
  '../../browser/guest-lifecycle/manager/browser-manager': {
    browserManager: { setBrowserGuestStateChangedListener: idle(), setOffscreenTabOpener: idle() }
  },
  '../../browser/sessions/profiles/browser-session-registry': { browserSessionRegistry: {} },
  '../../browser/routing/local-host-partitions/local-ssh-browser-route': {
    closeAllLocalSshBrowserRoutes: settled()
  },
  '../../codex/history/index/codex-state-db-backfill-recovery': {
    stopCodexStateDbBackfillRecoveries: settled()
  },
  '../../codex/history/bridges/codex-account-session-bridge': {
    stopCodexAccountSessionBridges: idle()
  },
  '../../git/refs/maintenance/local-repo-ref-maintenance': {
    awaitPackedRefsLockRelease: settled()
  },
  '../../workspaces/removal/worktree-background-removal': {
    stopBackgroundWorktreeRemovals: idle()
  },
  '../../dock/unread-badge': { setUnreadDockBadgeCount: idle() },
  '../../tray/system-tray': { destroySystemTray: idle() },
  '../../telemetry/client': { shutdownTelemetry: settled() },
  '../../observability/index': { shutdownObservability: settled() },
  '../../updater/updater-service': { isQuittingForUpdate: vi.fn(() => false) },
  '../../updater/updater-lifecycle-diagnostics': { recordUpdaterLifecycle: idle() },
  '../../macos-permissions/macos-tcc-prompt-notice': { stopTccPromptNotice: idle() },
  '../../pty/history/terminal-history-gc': { cancelHistoryGc: idle() },
  './window-all-closed-quit-policy': { shouldQuitWhenAllWindowsClosed: vi.fn(() => false) },
  '../configure-process': { isDevParentShutdownRequested: vi.fn(() => false) },
  '../../persistence/loading-store/user-data-path': {
    getCanonicalUserDataPath: vi.fn(() => '/unused')
  }
}

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('../main-process-state')
  for (const moduleName of Object.keys(dependencies)) {
    vi.doUnmock(moduleName)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

async function startQuit(
  flushFinalOrThrowAsync: () => Promise<void>,
  services: Record<string, unknown> = {},
  settings: { stopTerminalSessionsOnQuit?: boolean } = {},
  freezeWrites: () => Promise<void> = async () => {}
) {
  beginSshShutdown.mockClear()
  killAllPty.mockClear()
  disconnectDaemon.mockClear()
  killAllDaemonSessions.mockClear()
  vi.resetModules()
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const admission = { release: vi.fn() }
  const store = {
    flushFinalOrThrowAsync: vi.fn(flushFinalOrThrowAsync),
    freezeWritesAsync: vi.fn(freezeWrites),
    getSettings: () => settings
  }
  const profileStateAdmission: typeof admission | undefined = admission
  const state = {
    isQuitting: false,
    watcherShutdownDone: true,
    store,
    profileStateAdmission,
    ...services
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('../main-process-state', () => ({ mainProcessState: state }))
  for (const [moduleName, exports] of Object.entries(dependencies)) {
    vi.doMock(moduleName, () => exports)
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  const { quitTeardownStartGate } = await import('./quit-teardown-start-gate')
  quitTeardownStartGate.resetForTests()
  installMainProcessQuitHandlers()
  app.emit('before-quit', { defaultPrevented: false })
  app.emit('will-quit', { preventDefault: vi.fn() })
  return { app, admission, store, state }
}

it('quits at the teardown deadline without releasing admission while the writer is pending', async () => {
  const { app, admission, store, state } = await startQuit(() => new Promise<void>(() => {}))
  await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS - 1)
  expect(app.quit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(app.quit).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
    pendingTeardowns: ['state']
  })
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(store.freezeWritesAsync).not.toHaveBeenCalled()
  expect(admission.release).not.toHaveBeenCalled()
  expect(state.profileStateAdmission).toBe(admission)
})

// Exits from killed sessions must land after the frozen save, or next launch would drop their tabs.
it('stops terminal sessions only after the final save freezes, and disconnects only after they stop', async () => {
  const finalSave = Promise.withResolvers<void>()
  const freeze = Promise.withResolvers<void>()
  const stop = Promise.withResolvers<DaemonKillAllResult>()
  killAllDaemonSessions.mockImplementationOnce(() => stop.promise)
  const { app } = await startQuit(
    () => finalSave.promise,
    {},
    { stopTerminalSessionsOnQuit: true },
    () => freeze.promise
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(killAllDaemonSessions).not.toHaveBeenCalled()
  finalSave.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(killAllDaemonSessions).not.toHaveBeenCalled()
  freeze.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(killAllDaemonSessions).toHaveBeenCalledOnce()
  expect(disconnectDaemon).not.toHaveBeenCalled()
  stop.resolve({ killedCount: 1, remainingCount: 0, killedSessionIds: ['a'] })
  await vi.advanceTimersByTimeAsync(0)
  expect(disconnectDaemon).toHaveBeenCalledOnce()
  expect(app.quit).toHaveBeenCalledOnce()
})
