import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  OrchestrationDb,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'
import { TerminalHost } from '../../daemon/terminal-host'
import { DaemonPtyRouter } from '../../daemon/daemon-pty-router'
import type { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import type { SubprocessHandle } from '../../daemon/session-subprocess-handle'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../ipc/pty/provider/registry'
import {
  inspectExitedIncarnationFromRuntimeController,
  releaseExitedIncarnationFromRuntimeController
} from '../../ipc/pty/runtime/operations'

function daemonRouterOver(
  host: TerminalHost,
  beforeConsumption: () => Promise<void> = async () => {}
): DaemonPtyRouter {
  const adapter = {
    // Nothing in this process routes the id any more: the app restarted after the shell ended.
    hasPty: () => false,
    inspectProcess: (id: string, options?: { expectedIncarnationId?: string }) =>
      host.inspectProcess(id, options),
    consumeExitReceipt: async (id: string, incarnationId: string) => {
      await beforeConsumption()
      host.consumeExitReceipt(id, incarnationId)
    },
    listProcesses: async () => [],
    onData: () => () => {},
    onExit: () => () => {},
    onWriteUnavailable: () => () => {},
    onBackgroundStreamEvent: () => () => {}
  } as unknown as DaemonPtyAdapter
  return new DaemonPtyRouter({ current: adapter, legacy: [] })
}

function daemonSubprocess(): SubprocessHandle & { exit(code: number): void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 4242,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback: (code: number) => void) => {
      onExit = callback
    },
    dispose: vi.fn(),
    exit: (code: number) => onExit?.(code)
  } as unknown as SubprocessHandle & { exit(code: number): void }
}

describe('OrcaRuntimeService', () => {
  it('settles a local worker whose daemon session exited while the app was closed', async () => {
    const workerPaneKey = `legacy-daemon-exit:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-daemon-worker'
    const subprocess = daemonSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    // Orca quits (the client's attachment drops), then the worker's shell ends.
    const created = await host.createOrAttach({
      sessionId: ptyId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(ptyId, created.attachToken as symbol)
    subprocess.exit(0)

    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-daemon-exit',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-daemon-exit-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    const previousProvider = getLocalPtyProvider()
    setLocalPtyProvider(daemonRouterOver(host))
    try {
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'daemon worker' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_daemon_exit',
        paneKey: workerPaneKey,
        processIncarnation: `${ptyId}:${created.incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      // No stub: this is the shipped proof chain, from the recovery port through
      // providerObservedIncarnationExit and the daemon router to the host that watched it die.
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        inspectExitedIncarnation: (candidatePtyId, incarnationId) =>
          inspectExitedIncarnationFromRuntimeController(candidatePtyId, incarnationId),
        releaseExitedIncarnation: releaseExitedIncarnationFromRuntimeController,
        listProcesses: async () => []
      })
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)

      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })
      expect(db.getDispatchContextById(started.dispatch.id)?.status).not.toBe('dispatched')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      // Settled durably, so the owner told the host and the host holds nothing for this process.
      expect(() =>
        host.inspectProcess(ptyId, { expectedIncarnationId: created.incarnationId })
      ).toThrow()
    } finally {
      setLocalPtyProvider(previousProvider)
      await host.dispose()
      db.close()
    }
  })

  it('keeps the daemon exit when the orchestration write failed after the surface persisted', async () => {
    const workerPaneKey = `legacy-daemon-dbfail:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-daemon-dbfail'
    const subprocess = daemonSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const created = await host.createOrAttach({
      sessionId: ptyId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(ptyId, created.attachToken as symbol)
    subprocess.exit(0)

    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-daemon-dbfail',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-daemon-dbfail-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    const previousProvider = getLocalPtyProvider()
    setLocalPtyProvider(daemonRouterOver(host))
    try {
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'daemon worker' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_daemon_dbfail',
        paneKey: workerPaneKey,
        processIncarnation: `${ptyId}:${created.incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      // The surface persists, then the orchestration write is refused (a locked database).
      vi.spyOn(db, 'reconcileMissingWorkerTerminal').mockImplementationOnce(() => {
        throw new Error('database is locked')
      })
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        inspectExitedIncarnation: (candidatePtyId, incarnationId) =>
          inspectExitedIncarnationFromRuntimeController(candidatePtyId, incarnationId),
        releaseExitedIncarnation: releaseExitedIncarnationFromRuntimeController,
        listProcesses: async () => []
      })
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)

      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: [started.dispatch.id]
      })
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      // Release must follow the durable write, or this retry has nothing to read.
      await expect(
        host.inspectProcess(ptyId, { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })
    } finally {
      setLocalPtyProvider(previousProvider)
      await host.dispose()
      db.close()
    }
  })

  it('keeps the daemon exit when the settlement did not persist, so the next sweep can retry', async () => {
    const workerPaneKey = `legacy-daemon-unsettled:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-daemon-unsettled'
    const subprocess = daemonSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const created = await host.createOrAttach({
      sessionId: ptyId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(ptyId, created.attachToken as symbol)
    subprocess.exit(0)

    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-daemon-unsettled',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-daemon-unsettled-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    // The workspace-session flush fails, so persist reports nothing settled.
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        flushPendingOrThrowAsync: vi.fn(() => Promise.reject(new Error('disk full')))
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    const previousProvider = getLocalPtyProvider()
    setLocalPtyProvider(daemonRouterOver(host))
    try {
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'daemon worker' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_daemon_unsettled',
        paneKey: workerPaneKey,
        processIncarnation: `${ptyId}:${created.incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        inspectExitedIncarnation: (candidatePtyId, incarnationId) =>
          inspectExitedIncarnationFromRuntimeController(candidatePtyId, incarnationId),
        releaseExitedIncarnation: releaseExitedIncarnationFromRuntimeController,
        listProcesses: async () => []
      })
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)

      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: [started.dispatch.id]
      })
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      // Reading the proof was not acting on it: the host still holds it for the next sweep.
      await expect(
        host.inspectProcess(ptyId, { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })
    } finally {
      setLocalPtyProvider(previousProvider)
      await host.dispose()
      db.close()
    }
  })

  it('never ends a shell that took the pane id between the proof and the release', async () => {
    const workerPaneKey = `legacy-daemon-respawn:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-daemon-respawn'
    let subprocess = daemonSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const created = await host.createOrAttach({
      sessionId: ptyId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(ptyId, created.attachToken as symbol)
    subprocess.exit(0)

    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-daemon-respawn',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-daemon-respawn-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    const previousProvider = getLocalPtyProvider()
    // Pane restore raced the sweep: its respawn onto the same stable id reached the host first.
    let replacement: typeof subprocess | undefined
    setLocalPtyProvider(
      daemonRouterOver(host, async () => {
        subprocess = daemonSubprocess()
        replacement = subprocess
        await host.createOrAttach({
          sessionId: ptyId,
          cols: 80,
          rows: 24,
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      })
    )
    try {
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'daemon worker' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_daemon_respawn',
        paneKey: workerPaneKey,
        processIncarnation: `${ptyId}:${created.incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        inspectExitedIncarnation: (candidatePtyId, incarnationId) =>
          inspectExitedIncarnationFromRuntimeController(candidatePtyId, incarnationId),
        releaseExitedIncarnation: releaseExitedIncarnationFromRuntimeController,
        listProcesses: async () => []
      })
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)

      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        exitedDispatchIds: [started.dispatch.id]
      })
      // The old exit settled; the shell the user just got back is untouched.
      expect(replacement?.kill).not.toHaveBeenCalled()
      expect(replacement?.forceKill).not.toHaveBeenCalled()
      expect(host.listSessions()).toMatchObject([{ sessionId: ptyId, isAlive: true }])
    } finally {
      setLocalPtyProvider(previousProvider)
      await host.dispose()
      db.close()
    }
  })
})
