import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../../persistence/persistence-test-harness'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../../shared/quit-teardown-deadline'

const settled = () => vi.fn(async () => {})
const idle = () => vi.fn()
const stopAgentHookServer = idle()
const stopStructuredAgentSessionRuntime = settled()
const beginSshShutdown = settled()
const killAllPty = idle()
const disconnectDaemon = settled()
const closeAllWatchers = settled()

// Every teardown member settles except the profile store, so only the writer can hold quit.
const dependencies: Record<string, Record<string, unknown>> = {
  '../../ipc/filesystem/watchers/filesystem-watcher-shutdown': { closeAllWatchers },
  '../../ipc/worktrees/creation/worktree-base-directory-watcher': {
    disposeWorktreeBaseDirectoryWatchers: settled()
  },
  '../../ipc/folder-repo-git-upgrade': { stopFolderRepoGitUpgradeWatch: idle() },
  '../../ipc/pty/kill-all': { killAllPty },
  '../../daemon/providers/lifecycle/daemon-provider-state': {
    disconnectDaemon,
    shutdownDaemon: settled()
  },
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
  beforeQuit?: () => Promise<void>
) {
  disconnectDaemon.mockClear()
  closeAllWatchers.mockClear()
  beginSshShutdown.mockClear()
  killAllPty.mockClear()
  vi.resetModules()
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const admission = { release: vi.fn() }
  const store = {
    flushPendingOrThrowAsync: settled(),
    flushFinalOrThrowAsync: vi.fn(flushFinalOrThrowAsync),
    freezeWritesAsync: settled()
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
  await beforeQuit?.()
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

it('keeps profile, watcher and daemon ownership until successful removal metadata and journal settle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-quit-removal-'))
  let release!: () => void
  let readRecords!: () => Promise<unknown[]>
  let reset!: () => void
  const { store, admission } = await startQuit(
    async () => {},
    { watcherShutdownDone: false },
    async () => {
      const { worktreeRemovalLifetime } =
        await import('../../workspaces/removal/worktree-removal-lifetime')
      const { holdRemovalMetadata } =
        await import('../../workspaces/removal/worktree-removal-lifetime.test-fixtures')
      release = (await holdRemovalMetadata(directory)).release
      const records = await import('../../workspaces/removal/worktree-removal-records')
      readRecords = () => records.readWorktreeRemovalRecords(directory)
      reset = (await import('../../workspaces/removal/worktree-background-removal'))
        ._resetPendingWorktreeRemovalsForTests
      expect(worktreeRemovalLifetime.closing).toBe(false)
    }
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(store.flushFinalOrThrowAsync).not.toHaveBeenCalled()
  expect(admission.release).not.toHaveBeenCalled()
  expect(disconnectDaemon).not.toHaveBeenCalled()
  expect(closeAllWatchers).not.toHaveBeenCalled()
  expect(await readRecords()).toHaveLength(1)
  release()
  await vi.waitFor(() => expect(admission.release).toHaveBeenCalledOnce())
  expect(await readFile(join(directory, 'metadata-finished'), 'utf8')).toBe('removed')
  expect(await readRecords()).toEqual([])
  reset()
  await rm(directory, { recursive: true, force: true })
  expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
  expect(admission.release).toHaveBeenCalledOnce()
  expect(disconnectDaemon).toHaveBeenCalledOnce()
  expect(closeAllWatchers).toHaveBeenCalledOnce()
})

it('finishes saving after a quiescent removal reports failure, retaining the failed ownership fence', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { store, admission } = await startQuit(
    async () => {},
    { watcherShutdownDone: false },
    async () => {
      const { worktreeRemovalLifetime } =
        await import('../../workspaces/removal/worktree-removal-lifetime')
      await expect(
        worktreeRemovalLifetime.prepare(
          async () => {
            throw new Error('load failed')
          },
          () => {},
          async () => {}
        )
      ).rejects.toThrow('load failed')
    }
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
  expect(admission.release).not.toHaveBeenCalled()
  expect(disconnectDaemon).toHaveBeenCalledOnce()
  expect(closeAllWatchers).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith(
    '[worktrees] Failed to finish stopping workspace deletion:',
    expect.any(Error)
  )
})

it('checkpoints pane state during a held synchronous deletion, then saves later metadata before releasing ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-quit-checkpoint-'))
  const { Store } = await import('../../persistence/loading-store/store')
  const dataFile = join(directory, 'orca-data.json')
  const profile = createSqliteTestStore(Store, { dataFile })
  const savedTab = () => JSON.parse(readPersistedStateJson(dataFile)).workspaceSession.activeTabId
  await profile.flushPendingOrThrowAsync({ fullCheckpoint: true })
  const checkpointSaved = Promise.withResolvers<void>()
  const savePending = profile.flushPendingOrThrowAsync.bind(profile)
  vi.spyOn(profile, 'flushPendingOrThrowAsync').mockImplementation(async (...args) => {
    try {
      await savePending(...args)
      checkpointSaved.resolve()
    } catch (error) {
      checkpointSaved.reject(error)
      throw error
    }
  })
  const final = vi.spyOn(profile, 'flushFinalOrThrowAsync')
  const freeze = vi.spyOn(profile, 'freezeWritesAsync')
  let release!: () => void
  let captureGrid!: () => void
  const grid = new Promise<void>((resolve) => {
    captureGrid = () => {
      profile.getWorkspaceSession().activeTabId = 'pane-grid-before-stop'
      resolve()
    }
  })
  const runtime = {
    flushPaneGrids: () => grid,
    getOffscreenBrowserBackend: () => null,
    getAgentBrowserBridge: () => null,
    getEmulatorBridge: () => null,
    disposeSkillUploadSessions: async () => {},
    getRuntimeId: () => undefined,
    closeNotificationDismissals: async () => {}
  }
  try {
    const { admission, app } = await startQuit(
      async () => {},
      { store: profile, runtime, watcherShutdownDone: false },
      async () => {
        const { worktreeRemovalLifetime } =
          await import('../../workspaces/removal/worktree-removal-lifetime')
        release = worktreeRemovalLifetime.acquirePreparation()
      }
    )
    captureGrid()
    await grid
    await checkpointSaved.promise
    expect(savedTab()).toBe('pane-grid-before-stop')
    await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(final).not.toHaveBeenCalled()
    expect(freeze).not.toHaveBeenCalled()
    expect(admission.release).not.toHaveBeenCalled()
    expect(closeAllWatchers).not.toHaveBeenCalled()
    expect(disconnectDaemon).not.toHaveBeenCalled()
    profile.getWorkspaceSession().activeTabId = 'metadata-after-delete'
    release()
    await vi.waitFor(() => expect(admission.release).toHaveBeenCalledOnce())
    expect(savedTab()).toBe('metadata-after-delete')
    expect(freeze).toHaveBeenCalledOnce()
  } finally {
    release?.()
    await closeTestStores()
    await rm(directory, { recursive: true, force: true })
  }
})
