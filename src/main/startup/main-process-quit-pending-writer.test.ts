import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../quit-teardown-deadline'

const settled = () => vi.fn(async () => {})
const idle = () => vi.fn()

// Every teardown member settles except the profile store, so only the writer can hold quit.
const dependencies: Record<string, Record<string, unknown>> = {
  '../ipc/filesystem-watcher': { closeAllWatchers: settled() },
  '../ipc/worktree-base-directory-watcher': { disposeWorktreeBaseDirectoryWatchers: settled() },
  '../ipc/folder-repo-git-upgrade': { stopFolderRepoGitUpgradeWatch: idle() },
  '../ipc/pty': { killAllPty: idle() },
  '../daemon/daemon-init': { disconnectDaemon: settled(), shutdownDaemon: settled() },
  '../ipc/ssh-shutdown-drain': { beginSshShutdown: settled() },
  '../agent-hooks/server': { agentHookServer: { stop: idle() } },
  '../agent-hooks/wsl-hook-relay-manager': { wslHookRelayManager: { disposeAll: idle() } },
  '../agent-hooks/managed-agent-hook-controls': {
    removeManagedAgentHooksAsync: vi.fn(async () => [])
  },
  '../runtime/structured-agent-session-runtime': { stopStructuredAgentSessionRuntime: settled() },
  '../runtime/structured-agent-session-runtime-teardown': {
    setStructuredAgentSessionTeardownTrigger: idle()
  },
  '../runtime/orca-runtime-files': { awaitRuntimeFileWatcherUnsubscribes: settled() },
  '../runtime/runtime-metadata': { clearRuntimeMetadataIfOwned: idle() },
  '../browser/paired-runtime-browser-client-host-runtime': {
    shutdownPairedRuntimeBrowserClientHosts: settled()
  },
  '../browser/browser-manager': { browserManager: { setBrowserGuestStateChangedListener: idle() } },
  '../browser/local-ssh-browser-route': { closeAllLocalSshBrowserRoutes: settled() },
  '../codex/codex-state-db-backfill-recovery': { stopCodexStateDbBackfillRecoveries: settled() },
  '../codex/codex-account-session-bridge': { stopCodexAccountSessionBridges: idle() },
  '../git/local-repo-ref-maintenance': { awaitPackedRefsLockRelease: settled() },
  '../worktree-background-removal': { stopBackgroundWorktreeRemovals: idle() },
  '../dock/unread-badge': { setUnreadDockBadgeCount: idle() },
  '../tray/system-tray': { destroySystemTray: idle() },
  '../telemetry/client': { shutdownTelemetry: settled() },
  '../observability': { shutdownObservability: settled() },
  '../updater': { isQuittingForUpdate: vi.fn(() => false) },
  '../updater-lifecycle-diagnostics': { recordUpdaterLifecycle: idle() },
  '../macos-tcc-prompt-notice': { stopTccPromptNotice: idle() },
  '../terminal-history-gc': { cancelHistoryGc: idle() },
  './window-all-closed-quit-policy': { shouldQuitWhenAllWindowsClosed: vi.fn(() => false) },
  './configure-process': { isDevParentShutdownRequested: vi.fn(() => false) },
  '../persistence': { getCanonicalUserDataPath: vi.fn(() => '/unused') }
}

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  for (const moduleName of Object.keys(dependencies)) {
    vi.doUnmock(moduleName)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

async function startQuit(
  flushFinalOrThrowAsync: () => Promise<void>,
  notificationFlush: () => Promise<void> = async () => {},
  producers = { session: async () => {}, rpc: async () => {} }
) {
  vi.resetModules()
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const admission = { release: vi.fn() }
  const store = {
    flushFinalOrThrowAsync: vi.fn(flushFinalOrThrowAsync),
    freezeWritesAsync: settled()
  }
  const profileStateAdmission: typeof admission | undefined = admission
  const runtime = {
    getOffscreenBrowserBackend: () => undefined,
    getAgentBrowserBridge: () => undefined,
    getEmulatorBridge: () => undefined,
    disposeSkillUploadSessions: settled(),
    getRuntimeId: () => undefined,
    flushMobileNotificationPersistence: vi.fn(notificationFlush)
  }
  const state = {
    isQuitting: false,
    watcherShutdownDone: true,
    store,
    profileStateAdmission,
    runtime,
    runtimeRpc: { stop: vi.fn(producers.rpc), setMobileRelayPairingProvider: idle() }
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  for (const [moduleName, exports] of Object.entries(dependencies)) {
    vi.doMock(moduleName, () => exports)
  }
  vi.doMock('../runtime/structured-agent-session-runtime', () => ({
    stopStructuredAgentSessionRuntime: vi.fn(producers.session)
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  const { quitTeardownStartGate } = await import('../quit-teardown-start-gate')
  quitTeardownStartGate.resetForTests()
  installMainProcessQuitHandlers()
  app.emit('before-quit', { defaultPrevented: false })
  app.emit('will-quit', { preventDefault: vi.fn() })
  return { app, admission, store, state, runtime }
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

it('releases admission only after the final flush and freeze complete', async () => {
  const { app, admission, store } = await startQuit(async () => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
  expect(admission.release).toHaveBeenCalledOnce()
  expect(app.quit).toHaveBeenCalledOnce()
})

it('waits for pending dismissal persistence before orderly quit', async () => {
  const pending = Promise.withResolvers<void>()
  const { app, runtime } = await startQuit(
    async () => {},
    () => pending.promise
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.flushMobileNotificationPersistence).toHaveBeenCalledOnce()
  expect(app.quit).not.toHaveBeenCalled()
  pending.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(app.quit).toHaveBeenCalledOnce()
})

it('bounds a stalled dismissal flush with the existing teardown deadline', async () => {
  const { app } = await startQuit(
    async () => {},
    () => new Promise<void>(() => {})
  )
  await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS)
  expect(app.quit).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
    pendingTeardowns: ['notification-dismissals']
  })
})

it('includes final producer changes before draining dismissal persistence', async () => {
  const session = Promise.withResolvers<void>()
  const rpc = Promise.withResolvers<void>()
  const write = Promise.withResolvers<void>()
  const recorded: string[] = []
  const { app, runtime } = await startQuit(
    async () => {},
    () => {
      expect(recorded).toEqual(['session-dismissal', 'rpc-dismissal'])
      return write.promise
    },
    {
      session: async () => {
        await session.promise
        recorded.push('session-dismissal')
      },
      rpc: async () => {
        await rpc.promise
        recorded.push('rpc-dismissal')
      }
    }
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.flushMobileNotificationPersistence).not.toHaveBeenCalled()
  session.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.flushMobileNotificationPersistence).not.toHaveBeenCalled()
  rpc.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.flushMobileNotificationPersistence).toHaveBeenCalledOnce()
  expect(app.quit).not.toHaveBeenCalled()
  write.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(app.quit).toHaveBeenCalledOnce()
})
