// PRB-0219 / upstream #18737 — FUNCTIONAL (integration) reproduction of the steady-state
// worker-release reap LEAK.
//
// This is the "functional/integration" tier of the PRB-0219 test strategy. It wires the REAL
// orchestration RPC surface (orchestration.workerStart / workerRelease / workerList), the REAL
// OrchestrationDb, and the REAL release completion + observation modules against a fake runtime
// that faithfully models the two identity planes involved in the bug:
//
//   * VOLATILE, epoch-fenced handle table  — `handleTable` keyed by terminal handle, each entry
//     stamped with the `rendererGraphEpoch` at which it was issued. `showTerminal` resolves a
//     handle ONLY while its stamped epoch matches the current epoch (mirrors getLiveLeafForHandle
//     throwing 'terminal_handle_stale' on a rendererGraphEpoch bump). A relay reconnect / renderer
//     remount on headless serve bumps the epoch.
//   * DURABLE, incarnation-addressed process table — `ptysById` keyed by the ptyId embedded in the
//     worker's persisted process_incarnation (`${ptyId}:${incarnationId}`). The pty stays LIVE
//     across an epoch bump; nothing about the graph epoch kills the process.
//
// The bug (mechanism): when the epoch bumps, the durable db handle stops resolving through
// showTerminal WHILE THE PTY IS STILL ALIVE. inspectWorkerTerminal swallows the throw and reports
// `missing`; completeWorkerTerminalRelease then commits `release_unknown` and returns WITHOUT ever
// calling runtime.closeTerminal — so the process/PTY leaks. On mtl-02 those orphans accumulate in
// the orca-serve@factory cgroup until TasksMax=4096 is hit and Bun/omp abort() on EAGAIN.
//
// The observable leak signal asserted here: state 'release_unknown' + processAction 'none' +
// closeTerminal NEVER called + the pty STILL alive in ptysById + worker-list terminalState stuck
// on 'release_unknown' (never 'released').

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

describe('PRB-0219 worker-release reap FIX (functional verification)', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  // Dispatch/automation ptyId shape: `${repoId}::${worktreePath}@@${suffix}` (executionHostId:null).
  const PTY_ID = 'repo-7f3a::/data/wt/factory-task-1@@a1b2c3d4'
  const INCARNATION_ID = 1
  const PROCESS_INCARNATION = `${PTY_ID}:${INCARNATION_ID}`

  // ---- fake runtime process/handle planes (module-level so spies can mutate them) ----
  let ptysById: Map<string, { incarnationId: number; alive: boolean }>
  let handleTable: Map<string, { ptyId: string; epoch: number }>
  let rendererGraphEpoch: number
  let closedPtyIds: string[]

  /** Resolve a handle to its live pty only while its stamped graph epoch is current. */
  function resolveHandleToLivePty(
    handle: string
  ): { ptyId: string; pty: { incarnationId: number; alive: boolean } } | null {
    const entry = handleTable.get(handle)
    if (!entry) {
      return null
    }
    if (entry.epoch !== rendererGraphEpoch) {
      // rendererGraphEpoch fence: the durable handle no longer resolves to a live leaf.
      return null
    }
    const pty = ptysById.get(entry.ptyId)
    if (!pty || !pty.alive) {
      return null
    }
    return { ptyId: entry.ptyId, pty }
  }

  /** Wire the real RPC surface and db against the two-plane fake runtime. */
  function setup(): void {
    ptysById = new Map([
      ['coord-pty', { incarnationId: 1, alive: true }],
      [PTY_ID, { incarnationId: INCARNATION_ID, alive: true }]
    ])
    handleTable = new Map([
      ['term_coord', { ptyId: 'coord-pty', epoch: 0 }],
      ['term_worker', { ptyId: PTY_ID, epoch: 0 }]
    ])
    rendererGraphEpoch = 0
    closedPtyIds = []

    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    // Incarnation-addressed liveness probe: reads the DURABLE plane, so it stays 'live' across the
    // epoch bump (the process really is still running). Matches the real asymmetry.
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: (
          incarnation: string
        ) => Promise<'live' | 'exited'>
      }
    ).inspectTerminalProcessIncarnationLiveness = vi.fn(async (incarnation: string) => {
      const idx = incarnation.lastIndexOf(':')
      const ptyId = incarnation.slice(0, idx)
      const pty = ptysById.get(ptyId)
      return pty?.alive ? 'live' : 'exited'
    }) as never

    // The incarnation-addressed re-resolution primitive the fix adds. Present here as a spy so the
    // same harness proves BOTH tiers: pre-fix completion never calls it (leak); post-fix completion
    // calls it to remint a live handle (reap). Fence: EXACT incarnationId match only.
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: (
          incarnation: string,
          hostScope: string | null
        ) => string | null
      }
    ).resolveTerminalHandleByProcessIncarnation = vi.fn((incarnation: string): string | null => {
      const idx = incarnation.lastIndexOf(':')
      const ptyId = incarnation.slice(0, idx)
      const inc = Number(incarnation.slice(idx + 1))
      const pty = ptysById.get(ptyId)
      if (!pty || !pty.alive) {
        return null
      }
      if (pty.incarnationId !== inc) {
        // Fence: a reused ptyId with a different incarnation must NOT resolve.
        return null
      }
      // Remint a live handle at the current graph epoch.
      handleTable.set('term_reminted', { ptyId, epoch: rendererGraphEpoch })
      return 'term_reminted'
    }) as never

    // Identity plane (durable) — answers for the original AND any reminted handle. Independent of
    // the graph epoch, exactly like the real getTerminal* accessors that read dispatch authority.
    const knownWorkerHandle = (handle: string): boolean =>
      handle === 'term_worker' || handle === 'term_reminted'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : knownWorkerHandle(handle)
          ? workerPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      knownWorkerHandle(handle) ? PROCESS_INCARNATION : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      knownWorkerHandle(handle)
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: PROCESS_INCARNATION,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})

    // Volatile handle resolution — epoch-fenced. Throws 'terminal_handle_stale' once the epoch
    // moves past the epoch at which the handle was issued.
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (!resolveHandleToLivePty(handle)) {
        throw new Error('terminal_handle_stale')
      }
      return { handle, worktreeId: 'repo::worktree', status: 'running' } as never
    })

    // The reap: closing a handle kills exactly the pty it resolves to.
    vi.spyOn(runtime, 'closeTerminal').mockImplementation(async (handle) => {
      const live = resolveHandleToLivePty(handle)
      if (!live) {
        return { handle, tabId: null, ptyKilled: false } as never
      }
      live.pty.alive = false
      ptysById.delete(live.ptyId)
      closedPtyIds.push(live.ptyId)
      return { handle, tabId: `tab:${live.ptyId}`, ptyKilled: true } as never
    })

    // Remaining runtime surface required to start + settle a worker (mirrors the unit harness).
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    activeRunId = db.createRun({
      objective: 'PRB-0219 reap leak fixture',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  /** Look up a registered orchestration RPC method by name. */
  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  /** Parse a method's params and invoke its handler against the shared ctx. */
  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  /** Start a worker and settle its report, the state a release acts on. */
  async function startSettledWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'reap-leak fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    const settlement = db.settleWorkerReport({
      taskId: task.id,
      dispatchId: result.dispatchId,
      outcome: 'succeeded',
      result: 'worker succeeded'
    })
    expect(settlement.action).toBe('settled')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  /** The terminalState workerList projects for a dispatch, or null. */
  async function workerTerminalState(dispatchId: string): Promise<string | null> {
    const listed = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
    }
    return listed.workers.find((w) => w.dispatchId === dispatchId)?.terminalState ?? null
  }

  it('REAP (fixed): a rendererGraphEpoch bump strands the durable handle, but the incarnation fallback remints a live handle and reaps the process', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource?.process_incarnation).toBe(PROCESS_INCARNATION)

    // Relay reconnect / renderer remount bumps the graph epoch: the durable handle goes stale
    // while the PTY stays alive.
    rendererGraphEpoch = 1
    await expect(runtime.showTerminal('term_worker')).rejects.toThrow('terminal_handle_stale')
    expect(ptysById.get(PTY_ID)?.alive).toBe(true)

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    // The fix: inspectWorkerTerminal re-resolved the live PTY by process incarnation, reminted a
    // handle, and completion closed THAT handle — the process is actually reaped.
    expect(receipt.state).toBe('released')
    expect(receipt.processAction).toBe('closed_agent_terminal')
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
    expect(closedPtyIds).toEqual([PTY_ID])
    expect(ptysById.has(PTY_ID)).toBe(false)
    expect(await workerTerminalState(dispatchId)).toBe('released')
  })

  it('CONTROL: with the graph epoch intact the same release reaps exactly that PTY', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    expect(receipt.state).toBe('released')
    expect(receipt.processAction).toBe('closed_agent_terminal')
    expect(closedPtyIds).toEqual([PTY_ID])
    expect(ptysById.has(PTY_ID)).toBe(false)
    expect(await workerTerminalState(dispatchId)).toBe('released')
  })

  it('FENCE (fixed): a reused ptyId carrying a different incarnation must NOT remint or close — stays release_unknown', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()

    // The graph epoch bumps AND the ptyId has been reused by a different process (incarnation 2),
    // while the worker's recorded incarnation is still 1. The exact-incarnation fence must refuse.
    rendererGraphEpoch = 1
    const reused = ptysById.get(PTY_ID)
    if (reused) {
      reused.incarnationId = 2
    }

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    expect(receipt.state).toBe('release_unknown')
    expect(receipt.processAction).toBe('none')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    // The other lane's live process is left untouched (never reaped by an over-broad match).
    expect(ptysById.get(PTY_ID)?.alive).toBe(true)
    expect(await workerTerminalState(dispatchId)).toBe('release_unknown')
  })
})
