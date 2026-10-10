import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const dependencyExports: [string, string[]][] = [
  ['../ipc/filesystem-watcher', ['closeAllWatchers']],
  ['../ipc/worktree-base-directory-watcher', ['disposeWorktreeBaseDirectoryWatchers']],
  ['../ipc/folder-repo-git-upgrade', ['stopFolderRepoGitUpgradeWatch']],
  ['../ipc/pty', ['killAllPty']],
  ['../daemon/daemon-init', ['disconnectDaemon', 'shutdownDaemon']],
  ['../ipc/ssh-shutdown-drain', ['beginSshShutdown']],
  ['../agent-hooks/server', ['agentHookServer']],
  ['../agent-hooks/wsl-hook-relay-manager', ['wslHookRelayManager']],
  ['../agent-hooks/managed-agent-hook-controls', ['removeManagedAgentHooksAsync']],
  ['../runtime/structured-agent-session-runtime', ['stopStructuredAgentSessionRuntime']],
  [
    '../runtime/structured-agent-session-runtime-teardown',
    ['setStructuredAgentSessionTeardownTrigger']
  ],
  ['../runtime/orca-runtime-files', ['awaitRuntimeFileWatcherUnsubscribes']],
  ['../runtime/runtime-metadata', ['clearRuntimeMetadataIfOwned']],
  [
    '../browser/paired-runtime-browser-client-host-runtime',
    ['shutdownPairedRuntimeBrowserClientHosts']
  ],
  ['../browser/browser-manager', ['browserManager']],
  ['../codex/codex-state-db-backfill-recovery', ['stopCodexStateDbBackfillRecoveries']],
  ['../codex/codex-account-session-bridge', ['stopCodexAccountSessionBridges']],
  ['../git/local-repo-ref-maintenance', ['awaitPackedRefsLockRelease']],
  ['../worktree-background-removal', ['stopBackgroundWorktreeRemovals']],
  ['../quit-teardown-deadline', ['settleTeardownWithinDeadline', 'settleWithinMs']],
  ['../quit-teardown-start-gate', ['quitTeardownStartGate']],
  ['../dock/unread-badge', ['setUnreadDockBadgeCount']],
  ['../tray/system-tray', ['destroySystemTray']],
  ['../telemetry/client', ['shutdownTelemetry']],
  ['../observability', ['shutdownObservability']],
  ['../updater', ['isQuittingForUpdate']],
  ['../updater-lifecycle-diagnostics', ['recordUpdaterLifecycle']],
  ['../macos-tcc-prompt-notice', ['stopTccPromptNotice']],
  ['../terminal-history-gc', ['cancelHistoryGc']],
  ['./window-all-closed-quit-policy', ['shouldQuitWhenAllWindowsClosed']],
  ['./configure-process', ['isDevParentShutdownRequested']],
  ['../persistence', ['getCanonicalUserDataPath']]
]

it('keeps startup services live when the updater has vetoed before-quit', async () => {
  vi.resetModules()
  const app = new EventEmitter()
  const fenceAndCloseNow = vi.fn()
  const setMobileRelayPairingProvider = vi.fn()
  const unsubscribeAgentAwakeStatusChanges = vi.fn()
  const dispose = vi.fn()
  const stop = vi.fn()
  const state = {
    isQuitting: false,
    desktopRelayService: { fenceAndCloseNow },
    runtimeRpc: { setMobileRelayPairingProvider },
    unsubscribeAgentAwakeStatusChanges,
    agentAwakeService: { dispose },
    rateLimits: { stop }
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  for (const [moduleName, exports] of dependencyExports) {
    vi.doMock(moduleName, () => Object.fromEntries(exports.map((name) => [name, vi.fn()])))
  }
  const exitListenersBefore = process.listeners('exit')
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  installMainProcessQuitHandlers()

  app.emit('before-quit', { defaultPrevented: true })

  expect(state.isQuitting).toBe(false)
  expect(fenceAndCloseNow).not.toHaveBeenCalled()
  expect(setMobileRelayPairingProvider).not.toHaveBeenCalled()
  expect(unsubscribeAgentAwakeStatusChanges).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(state.agentAwakeService).toEqual({ dispose })
  expect(state.unsubscribeAgentAwakeStatusChanges).toBe(unsubscribeAgentAwakeStatusChanges)

  app.emit('before-quit', { defaultPrevented: false })

  expect(state.isQuitting).toBe(true)
  expect(fenceAndCloseNow).toHaveBeenCalledOnce()
  expect(setMobileRelayPairingProvider).toHaveBeenCalledWith(null)
  expect(unsubscribeAgentAwakeStatusChanges).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.includes(listener)) {
      process.removeListener('exit', listener)
    }
  }
})

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  for (const [moduleName] of dependencyExports) {
    vi.doUnmock(moduleName)
  }
  vi.resetModules()
})
