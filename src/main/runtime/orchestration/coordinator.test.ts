/* eslint-disable max-lines -- Why: coordinator tests cover dispatch, DAG ordering, escalation, decision gates, concurrency, and stop — splitting by category would scatter shared setup without improving clarity. */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  Coordinator,
  DISPATCH_STALE_THRESHOLD,
  parseAllowStaleBaseFromSpec,
  parseTrackFromSpec,
  worktreeNameForTask,
  type CoordinatorRuntime
} from './coordinator'
import type { WorktreeLineage } from '../../../shared/types'

// Why (F2 #13): the coordinator (main) produces the lineage edge here; Mission
// Control's `selectSpawnedWorktreeIds` (renderer) consumes it. Asserting that
// selector against the coordinator's exact lineage shape lives in the renderer
// test (orchestrator-mission-control-data.test.ts) to respect the main↔renderer
// project boundary — this test proves the producing half: parent === director.

type DriftResult = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

type CreatedWorktree = {
  worktreeId: string
  parentWorktreeId: string
  branch: string
  taskId?: string
  startupAgent?: string
}

function createMockRuntime(): CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  createdTerminals: string[]
  createTerminalCalls: { worktree?: string; launchAgent?: string }[]
  throwCreateTerminal: Error | null
  // round 3: the REAL agent-spawn path the coordinator must use on reuse-relaunch.
  launchAgentTerminalCalls: { worktree: string; agent: string; prompt: string }[]
  throwLaunchAgentTerminal: Error | null
  createdWorktrees: CreatedWorktree[]
  removedWorktrees: string[]
  waitForTerminalCalls: { handle: string; condition?: string }[]
  callOrder: string[]
  probeDriftCalls: string[]
  probeDriftResult: DriftResult
  setProbeDrift(result: DriftResult): void
  throwProbeDrift: Error | null
  // round 2 knobs: faithful to the real adapter, which returns a handle only
  // when it found/launched a terminal and can throw on provisioning failure.
  createWorktreeReturnsHandle: boolean
  throwCreateWorktree: Error | null
  throwWaitForTerminal: Error | null
} {
  const mock = {
    sentMessages: [] as { handle: string; text: string }[],
    terminals: [] as {
      handle: string
      worktreeId: string
      connected: boolean
      writable: boolean
    }[],
    createdTerminals: [] as string[],
    createTerminalCalls: [] as { worktree?: string; launchAgent?: string }[],
    throwCreateTerminal: null as Error | null,
    launchAgentTerminalCalls: [] as { worktree: string; agent: string; prompt: string }[],
    throwLaunchAgentTerminal: null as Error | null,
    createdWorktrees: [] as CreatedWorktree[],
    removedWorktrees: [] as string[],
    waitForTerminalCalls: [] as { handle: string; condition?: string }[],
    callOrder: [] as string[],
    probeDriftCalls: [] as string[],
    probeDriftResult: null as DriftResult,
    throwProbeDrift: null as Error | null,
    createWorktreeReturnsHandle: true,
    throwCreateWorktree: null as Error | null,
    throwWaitForTerminal: null as Error | null,
    setProbeDrift(result: DriftResult): void {
      mock.probeDriftResult = result
    },
    async sendTerminal(handle: string, action: { text?: string }) {
      mock.callOrder.push(`send:${handle}`)
      mock.sentMessages.push({ handle, text: action.text ?? '' })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal(worktree?: string, opts?: { title?: string; launchAgent?: string }) {
      mock.createTerminalCalls.push({ worktree, launchAgent: opts?.launchAgent })
      if (mock.throwCreateTerminal) {
        throw mock.throwCreateTerminal
      }
      const handle = `term_worker_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      // Why: in worktree-backed tests createTerminal is called with an
      // `id:<worktreeId>` selector; reflect that worktree so the terminal lands
      // in the right checkout. Falls back to 'wt1' for the legacy path.
      const worktreeId = worktree?.replace(/^id:/, '') ?? 'wt1'
      mock.terminals.push({ handle, worktreeId, connected: true, writable: true })
      return { handle, worktreeId, title: opts?.title ?? '' }
    },
    // Why (round 3): the REAL agent spawn — mirrors OrcaRuntimeService.launchAgentTerminal
    // (which builds a launch command via buildStartupForAgent). The coordinator must
    // use THIS, not createTerminal, to relaunch a worker agent on track reuse.
    async launchAgentTerminal(
      worktree: string,
      opts: { agent: string; prompt: string; title?: string }
    ) {
      mock.callOrder.push(`launchAgent:${worktree}`)
      mock.launchAgentTerminalCalls.push({ worktree, agent: opts.agent, prompt: opts.prompt })
      if (mock.throwLaunchAgentTerminal) {
        throw mock.throwLaunchAgentTerminal
      }
      const handle = `term_agent_${mock.launchAgentTerminalCalls.length - 1}`
      const worktreeId = worktree.replace(/^id:/, '')
      mock.terminals.push({ handle, worktreeId, connected: true, writable: true })
      return { handle, worktreeId }
    },
    async waitForTerminal(handle: string, options?: { condition?: string; timeoutMs?: number }) {
      mock.callOrder.push(`wait:${handle}`)
      mock.waitForTerminalCalls.push({ handle, condition: options?.condition })
      if (mock.throwWaitForTerminal) {
        throw mock.throwWaitForTerminal
      }
      return { handle, condition: options?.condition ?? 'exit' }
    },
    async probeWorktreeDrift(worktreeSelector: string): Promise<DriftResult> {
      mock.probeDriftCalls.push(worktreeSelector)
      if (mock.throwProbeDrift) {
        throw mock.throwProbeDrift
      }
      return mock.probeDriftResult
    },
    // Why (F2 #13): records the lineage parent the coordinator requested and
    // hands back a terminal in the new child worktree, mirroring the real
    // OrcaRuntimeService.createWorktree adapter contract. Round 2: it can throw
    // (provisioning failure) and can return NO handle (real adapter returns one
    // only when a terminal was found/launched) so both failure paths are covered.
    async createWorktree(opts: {
      parentWorktree: string
      name: string
      taskId?: string
      startup?: { agent: string }
    }): Promise<{ worktreeId: string; branch: string; terminalHandle?: string }> {
      if (mock.throwCreateWorktree) {
        throw mock.throwCreateWorktree
      }
      const idx = mock.createdWorktrees.length
      const worktreeId = `wt_child_${idx}`
      const parentWorktreeId = opts.parentWorktree.replace(/^id:/, '')
      mock.createdWorktrees.push({
        worktreeId,
        parentWorktreeId,
        // Why (round 2): the real adapter returns result.worktree.git?.branch,
        // which may be sanitized/conflict-suffixed — not the raw name. Reflect
        // that the branch can differ so tests don't assume branch === opts.name.
        branch: `${opts.name}-resolved`,
        taskId: opts.taskId,
        ...(opts.startup ? { startupAgent: opts.startup.agent } : {})
      })
      if (!mock.createWorktreeReturnsHandle) {
        // No usable terminal in the created worktree → coordinator must tear it
        // down and breaker-account, not dispatch into nothing.
        return { worktreeId, branch: `${opts.name}-resolved` }
      }
      const handle = `term_wt_${idx}`
      mock.terminals.push({ handle, worktreeId, connected: true, writable: true })
      return { worktreeId, branch: `${opts.name}-resolved`, terminalHandle: handle }
    },
    async removeWorktree(worktreeId: string): Promise<void> {
      mock.removedWorktrees.push(worktreeId)
    }
  }
  return mock
}

// Why (F2 #13): build the renderer's `worktreeLineageById` map from what the
// mock recorded, so the test exercises the SAME selectSpawnedWorktreeIds path
// Mission Control uses to discover a director's workers.
function lineageMapFromCreated(created: CreatedWorktree[]): Record<string, WorktreeLineage> {
  return Object.fromEntries(
    created.map((wt, i) => [
      wt.worktreeId,
      {
        worktreeId: wt.worktreeId,
        worktreeInstanceId: `${wt.worktreeId}-inst`,
        parentWorktreeId: wt.parentWorktreeId,
        parentWorktreeInstanceId: `${wt.parentWorktreeId}-inst`,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'explicit' },
        createdAt: i
      } satisfies WorktreeLineage
    ])
  )
}

// Why (F3 #14): poll a condition instead of asserting after a fixed delay, so a
// dispatch that lands slowly under CI load is awaited rather than missed — and the
// loop is never left ticking after the test moves on to db teardown.
async function waitFor(
  condition: () => boolean,
  { timeoutMs = 3000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {}
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met within timeout')
    }
    await new Promise((r) => {
      setTimeout(r, stepMs)
    })
  }
}

function insertWorkerDone(
  db: OrchestrationDb,
  params: {
    taskId: string
    to?: string
    from?: string
    dispatchId?: string
    filesModified?: string[]
  }
): void {
  const dispatch = db.getDispatchContext(params.taskId)
  const dispatchId = params.dispatchId ?? dispatch?.id
  if (!dispatchId) {
    throw new Error(`No dispatch for task ${params.taskId}`)
  }
  db.insertMessage({
    from: params.from ?? dispatch?.assignee_handle ?? 'term_unknown',
    to: params.to ?? 'coord',
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({
      taskId: params.taskId,
      dispatchId,
      ...(params.filesModified ? { filesModified: params.filesModified } : {})
    })
  })
}

describe('Coordinator', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('throws if no tasks exist', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const coordinator = new Coordinator(db, runtime, {
      spec: 'do stuff',
      coordinatorHandle: 'coord'
    })
    await expect(coordinator.run()).rejects.toThrow('No tasks found')
  })

  it('dispatches a ready task to an available terminal', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'implement feature' })

    // Simulate worker_done arriving after dispatch
    const coordinator = new Coordinator(db, runtime, {
      spec: 'build it',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    // Run coordinator in background, then simulate completion
    const runPromise = coordinator.run()

    // Wait for dispatch to happen
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Simulate the worker completing
    insertWorkerDone(db, { taskId: task.id, filesModified: ['a.ts'] })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(task.id)
    expect(runtime.sentMessages.length).toBeGreaterThan(0)
  })

  it('creates a terminal when none are available', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()

    const task = db.createTask({ spec: 'work' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    await new Promise((r) => {
      setTimeout(r, 100)
    })

    expect(runtime.createdTerminals.length).toBe(1)

    // Complete the task
    insertWorkerDone(db, { taskId: task.id, from: runtime.createdTerminals[0] })

    const result = await runPromise
    expect(result.status).toBe('completed')
  })

  it('handles escalation and circuit breaker', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_b', worktreeId: 'wt1', connected: true, writable: true }
    ]

    const task = db.createTask({ spec: 'risky work' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Send 3 escalations to trigger circuit breaker
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => {
        setTimeout(r, 100)
      })
      db.insertMessage({
        from: `term_${i === 0 ? 'a' : 'b'}`,
        to: 'coord',
        subject: `Failed attempt ${i + 1}`,
        type: 'escalation',
        payload: JSON.stringify({ taskId: task.id })
      })
    }

    const result = await runPromise
    expect(result.status).toBe('failed')
    expect(result.failedTasks).toContain(task.id)
  })

  it('reports failed when dispatch send failures circuit-break in the DB', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
    runtime.sendTerminal = async () => {
      throw new Error('terminal_not_writable')
    }

    const task = db.createTask({ spec: 'cannot dispatch' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10
    })

    const result = await coordinator.run()

    expect(result.status).toBe('failed')
    expect(result.failedTasks).toContain(task.id)
    expect(db.getTask(task.id)?.status).toBe('failed')
  })

  it('handles decision gate blocking and resolution', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'needs approval' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Wait for dispatch
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Worker sends decision gate
    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Need approval',
      type: 'decision_gate',
      payload: JSON.stringify({
        taskId: task.id,
        question: 'Proceed with destructive migration?',
        options: ['yes', 'no']
      })
    })

    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Verify task is blocked
    const blocked = db.getTask(task.id)
    expect(blocked?.status).toBe('blocked')
    expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()

    // Resolve the gate
    const gates = db.listGates({ taskId: task.id, status: 'pending' })
    expect(gates.length).toBe(1)
    db.resolveGate(gates[0].id, 'yes')

    // Wait for re-dispatch and simulate completion
    await new Promise((r) => {
      setTimeout(r, 200)
    })

    insertWorkerDone(db, { taskId: task.id })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(task.id)
  })

  it('respects task DAG ordering', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const t1 = db.createTask({ spec: 'first' })
    const t2 = db.createTask({ spec: 'second', deps: [t1.id] })

    expect(t2.status).toBe('pending')

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Wait for t1 dispatch
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // t2 should still be pending
    expect(db.getTask(t2.id)?.status).toBe('pending')

    // Complete t1
    insertWorkerDone(db, { taskId: t1.id })

    // Wait for t2 to be promoted and dispatched
    await new Promise((r) => {
      setTimeout(r, 200)
    })

    // t2 should now be dispatched
    const t2Status = db.getTask(t2.id)?.status
    expect(t2Status === 'dispatched' || t2Status === 'ready').toBe(true)

    // Complete t2
    insertWorkerDone(db, { taskId: t2.id })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(t1.id)
    expect(result.completedTasks).toContain(t2.id)
  })

  it('respects maxConcurrent limit', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_b', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_c', worktreeId: 'wt1', connected: true, writable: true }
    ]

    const t1 = db.createTask({ spec: 'one' })
    const t2 = db.createTask({ spec: 'two' })
    const t3 = db.createTask({ spec: 'three' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50,
      maxConcurrent: 2
    })

    const runPromise = coordinator.run()
    try {
      // Wait for the cap to bind on a CONDITION rather than a fixed delay: under
      // parallel-test load the first tick can land after a fixed sleep, leaving 0
      // dispatched and throwing before `await runPromise` — which would strand the
      // loop past db teardown (an unhandled "database is not open"). maxConcurrent
      // holds it at exactly 2; assert it does not creep above 2 across a few ticks.
      await waitFor(() => db.listTasks({ status: 'dispatched' }).length === 2)
      await new Promise((r) => {
        setTimeout(r, 60)
      })
      expect(db.listTasks({ status: 'dispatched' }).length).toBe(2)

      // Complete tasks as they are ACTUALLY dispatched, not in a fixed array order:
      // the cap picks 2 of the 3 by (created_at, id) — which two is not the array
      // order — so completing [t1,t2,t3] blindly can target an undispatched task.
      const remaining = new Set([t1.id, t2.id, t3.id])
      while (remaining.size > 0) {
        await waitFor(() =>
          db.listTasks({ status: 'dispatched' }).some((task) => remaining.has(task.id))
        )
        for (const task of db.listTasks({ status: 'dispatched' })) {
          if (remaining.has(task.id)) {
            insertWorkerDone(db, { taskId: task.id })
            remaining.delete(task.id)
          }
        }
      }

      const result = await runPromise
      expect(result.status).toBe('completed')
    } finally {
      coordinator.stop()
      await runPromise.catch(() => {})
    }
  })

  it('logs a stale warning for dispatched rows past the threshold and does not auto-fail', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    // No terminals available so dispatchReadyTasks creates one and we can
    // drive the stale-scan deterministically via SQL backdating.
    const task = db.createTask({ spec: 'work' })
    const ctx = db.createDispatchContext(task.id, 'term_stale')

    // Backdate dispatched_at and last_heartbeat_at beyond the 10-min threshold
    // so getStaleDispatches returns this row on the first tick.
    const sqlite = (
      db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).db
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString()
    sqlite
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
      .run(iso(60 * 60 * 1000), iso(30 * 60 * 1000), ctx.id)

    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      onLog: (m) => logs.push(m)
    })

    // Drive one tick then stop — we only need the stale warning to have fired.
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(logs.some((l) => /has not sent a heartbeat/.test(l) && l.includes(task.id))).toBe(true)
    // Task status must NOT have been auto-failed — logging only.
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })

  it('records heartbeat by dispatchId on worker heartbeat messages', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'work' })
    const ctx = db.createDispatchContext(task.id, 'term_a')

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })

    const runPromise = coordinator.run()

    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ taskId: task.id, dispatchId: ctx.id, phase: 'implementing' })
    })

    await new Promise((r) => {
      setTimeout(r, 80)
    })

    expect(db.getDispatchContext(task.id)?.last_heartbeat_at).toBeTruthy()

    // Complete the task so the coordinator run finishes cleanly.
    insertWorkerDone(db, { taskId: task.id })

    const result = await runPromise
    expect(result.status).toBe('completed')
  })

  it('ignores stale worker_done from a failed retry before accepting the active dispatch', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const logs: string[] = []

    const task = db.createTask({ spec: 'retry-sensitive work' })
    const staleCtx = db.createDispatchContext(task.id, 'term_old')
    db.failDispatch(staleCtx.id, 'retry elsewhere')
    const activeCtx = db.createDispatchContext(task.id, 'term_current')

    db.insertMessage({
      from: 'term_old',
      to: 'coord',
      subject: 'Late done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: staleCtx.id })
    })

    const staleCoordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      onLog: (m) => logs.push(m)
    })
    const staleRun = staleCoordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    staleCoordinator.stop()
    await staleRun

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(staleCtx.id)?.status).toBe('failed')
    expect(db.getDispatchContextById(activeCtx.id)?.status).toBe('dispatched')
    expect(logs.some((m) => m.includes('inactive dispatch'))).toBe(true)

    insertWorkerDone(db, {
      taskId: task.id,
      from: 'term_current',
      dispatchId: activeCtx.id
    })
    const completionCoordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })
    const result = await completionCoordinator.run()

    expect(result.status).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(activeCtx.id)?.status).toBe('completed')
  })

  it('ignores worker_done sent by a terminal that does not own the dispatch', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const logs: string[] = []

    const task = db.createTask({ spec: 'owned work' })
    const ctx = db.createDispatchContext(task.id, 'term_owner')

    db.insertMessage({
      from: 'term_intruder',
      to: 'coord',
      subject: 'Spoofed done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: ctx.id })
    })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      onLog: (m) => logs.push(m)
    })
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(ctx.id)?.status).toBe('dispatched')
    expect(logs.some((m) => m.includes('expected term_owner'))).toBe(true)
  })

  it('can be stopped', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    db.createTask({ spec: 'never finishes' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    await new Promise((r) => {
      setTimeout(r, 100)
    })
    coordinator.stop()

    const result = await runPromise
    expect(result.status).toBe('failed')
  })

  describe('worktree-backed dispatch (F2 #13)', () => {
    it('creates a lineage-visible child worktree (parent = director) that Mission Control finds', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      const directorWorktreeId = 'director-wt'

      const task = db.createTask({ spec: 'implement the bridge' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: directorWorktreeId,
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()

      // Wait for the worktree to be created + dispatch to happen.
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      // A worktree was created with lineage parent = the director.
      expect(runtime.createdWorktrees).toHaveLength(1)
      const child = runtime.createdWorktrees[0]
      expect(child.parentWorktreeId).toBe(directorWorktreeId)
      expect(child.taskId).toBe(task.id)
      expect(child.startupAgent).toBe('claude')

      // The preamble was dispatched into the child worktree's terminal (no bare
      // terminal in the director was created on this path).
      expect(runtime.createdTerminals).toHaveLength(0)
      expect(runtime.sentMessages.some((m) => m.handle === `term_wt_0`)).toBe(true)

      // Round 2 (BLOCKER): the preamble waited for the agent TUI to be ready
      // (tui-idle) before being sent — and the wait happened BEFORE the send.
      expect(
        runtime.waitForTerminalCalls.some(
          (c) => c.handle === 'term_wt_0' && c.condition === 'tui-idle'
        )
      ).toBe(true)
      expect(runtime.callOrder.indexOf('wait:term_wt_0')).toBeLessThan(
        runtime.callOrder.indexOf('send:term_wt_0')
      )

      // Round 3: drift is probed on the DIRECTOR before the child is created (so
      // a stale base can't churn-create worktrees); the fresh child is NOT
      // re-probed.
      expect(runtime.probeDriftCalls).toContain(directorWorktreeId)
      expect(runtime.probeDriftCalls).not.toContain(`id:${child.worktreeId}`)

      // The produced lineage edge is exactly what Mission Control keys on
      // (parentWorktreeId === directorWorktreeId). The selectSpawnedWorktreeIds
      // consumer side is asserted in the renderer test against this same shape.
      const lineageById = lineageMapFromCreated(runtime.createdWorktrees)
      expect(lineageById[child.worktreeId].parentWorktreeId).toBe(directorWorktreeId)

      insertWorkerDone(db, { taskId: task.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(result.completedTasks).toContain(task.id)
    })

    it('default-off path is unchanged: dispatches to a bare terminal, never creates a worktree', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      // A pre-existing idle terminal in the director worktree (legacy flow).
      runtime.terminals = [
        { handle: 'term_a', worktreeId: 'director-wt', connected: true, writable: true }
      ]

      const task = db.createTask({ spec: 'legacy work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'director-wt'
        // worktreeBacked omitted → default false
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      // Legacy path: no worktree was created; the existing terminal got the work.
      expect(runtime.createdWorktrees).toHaveLength(0)
      expect(runtime.sentMessages.some((m) => m.handle === 'term_a')).toBe(true)

      insertWorkerDone(db, { taskId: task.id, from: 'term_a' })
      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(result.completedTasks).toContain(task.id)
    })

    it('skips worktree-backed dispatch (no orphan worktrees) when no director worktree is set', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      const logs: string[] = []

      db.createTask({ spec: 'needs a parent' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktreeBacked: true,
        // worktree (director) deliberately omitted → no lineage parent
        onLog: (m) => logs.push(m)
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })
      coordinator.stop()
      await runPromise

      // No parentless worktrees were created; the guard logged and skipped.
      expect(runtime.createdWorktrees).toHaveLength(0)
      expect(logs.some((m) => m.includes('worktree-backed dispatch requires a --worktree'))).toBe(
        true
      )
    })

    // Round 2 BLOCKER: the preamble must not be fired into a still-booting TUI.
    it('does NOT send the preamble when the agent never becomes ready, and breaker-fails the task', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      // The agent terminal never reaches tui-idle → waitForTerminal rejects.
      runtime.throwWaitForTerminal = new Error('timeout')

      const task = db.createTask({ spec: 'cold-boot worker' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 10,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const result = await coordinator.run()

      // The preamble was NEVER sent (would have been dropped into a booting TUI).
      expect(runtime.sentMessages).toHaveLength(0)
      // The readiness failure burned the breaker (3 strikes) → task failed,
      // not retried forever.
      expect(result.status).toBe('failed')
      expect(result.failedTasks).toContain(task.id)
      expect(db.getTask(task.id)?.status).toBe('failed')
      // Each failed attempt tore its worktree down — no orphans left behind.
      expect(runtime.removedWorktrees.length).toBeGreaterThan(0)
      expect(runtime.removedWorktrees.length).toBe(runtime.createdWorktrees.length)
    })

    // Round 2 SHOULD-FIX #2: createWorktree failures route through the breaker
    // (bounded retry → failed), instead of retrying every tick forever.
    it('breaker-fails a task whose worktree can never be created (no infinite retry)', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.throwCreateWorktree = new Error('disk full')

      const task = db.createTask({ spec: 'unprovisionable' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 10,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const result = await coordinator.run()

      expect(result.status).toBe('failed')
      expect(result.failedTasks).toContain(task.id)
      expect(db.getTask(task.id)?.status).toBe('failed')
      // createWorktree threw before creating anything → nothing to tear down.
      expect(runtime.createdWorktrees).toHaveLength(0)
      expect(runtime.removedWorktrees).toHaveLength(0)
    })

    // Round 2 SHOULD-FIX #2: a worktree created without a usable terminal is
    // torn down (no orphan) and the strike is breaker-accounted.
    it('tears down a worktree that has no usable terminal and breaker-fails the task', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.createWorktreeReturnsHandle = false

      const task = db.createTask({ spec: 'no terminal' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 10,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const result = await coordinator.run()

      expect(runtime.sentMessages).toHaveLength(0)
      expect(result.status).toBe('failed')
      expect(result.failedTasks).toContain(task.id)
      // Every created-but-unusable worktree was removed → no orphans.
      expect(runtime.removedWorktrees.length).toBe(runtime.createdWorktrees.length)
      expect(runtime.removedWorktrees.length).toBeGreaterThan(0)
    })

    // Round 2 SHOULD-FIX #3: the no-workerAgent path must NOT create a second
    // terminal (the real adapter reuses the one createManagedWorktree opened),
    // and it must NOT wait on tui-idle (a plain shell accepts input immediately).
    it('no-agent path dispatches without a second terminal and without a readiness wait', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const task = db.createTask({ spec: 'no agent configured' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'director-wt',
        worktreeBacked: true
        // workerAgent omitted → no startup agent
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      expect(runtime.createdWorktrees).toHaveLength(1)
      const child = runtime.createdWorktrees[0]
      expect(child.startupAgent).toBeUndefined()
      // The coordinator dispatched into the worktree's terminal and created NO
      // extra terminal of its own (no double-terminal).
      expect(runtime.createdTerminals).toHaveLength(0)
      expect(runtime.sentMessages.some((m) => m.handle === 'term_wt_0')).toBe(true)
      // No readiness wait for the plain-shell (no-agent) case.
      expect(runtime.waitForTerminalCalls).toHaveLength(0)

      insertWorkerDone(db, { taskId: task.id, from: 'term_wt_0' })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // Round 3 SHOULD-FIX #1: a stale base must not churn create→skip→teardown
    // every tick. Drift is probed on the director BEFORE createWorktree, so a
    // stale base skips WITHOUT ever creating (or removing) a worktree.
    it('does not churn worktrees when the base is stale: skips before creating, no create/remove', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      // Director base is far behind origin → every dispatch should drift-skip.
      runtime.setProbeDrift({
        base: 'origin/main',
        behind: DISPATCH_STALE_THRESHOLD + 50,
        recentSubjects: ['ahead 1', 'ahead 2']
      })
      const logs: string[] = []

      const task = db.createTask({ spec: 'work on a stale base' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 10,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude',
        onLog: (m) => logs.push(m)
      })

      const runPromise = coordinator.run()
      // Let several poll ticks elapse so a churn loop would be obvious.
      await new Promise((r) => {
        setTimeout(r, 120)
      })
      coordinator.stop()
      await runPromise

      // The fix: NO worktree was ever created (so none had to be removed) — the
      // skip happened before createWorktree. Without the fix this would be a
      // create→teardown pair on every tick (createdWorktrees/removedWorktrees
      // climbing with the tick count).
      expect(runtime.createdWorktrees).toHaveLength(0)
      expect(runtime.removedWorktrees).toHaveLength(0)
      expect(runtime.sentMessages).toHaveLength(0)
      // Drift was probed on the director, not on a (never-created) child.
      expect(runtime.probeDriftCalls.every((s) => s === 'director-wt')).toBe(true)
      // The task stays ready (recoverable, like legacy) — never breaker-failed.
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(logs.some((m) => m.includes('Skipping dispatch'))).toBe(true)
    })

    // Round 2 NIT: surface the worktreeBacked→legacy downgrade once.
    it('logs once when worktreeBacked is set but the runtime lacks createWorktree', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      // Strip the capability to simulate a runtime that cannot create worktrees.
      delete (runtime as { createWorktree?: unknown }).createWorktree
      runtime.terminals = [
        { handle: 'term_a', worktreeId: 'director-wt', connected: true, writable: true }
      ]
      const logs: string[] = []

      const task = db.createTask({ spec: 'falls back to legacy' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20,
        worktree: 'director-wt',
        worktreeBacked: true,
        onLog: (m) => logs.push(m)
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      // Fell back to legacy bare-terminal dispatch, and said so exactly once.
      expect(runtime.createdWorktrees).toHaveLength(0)
      expect(runtime.sentMessages.some((m) => m.handle === 'term_a')).toBe(true)
      const downgradeLogs = logs.filter((m) => m.includes('does not implement createWorktree'))
      expect(downgradeLogs).toHaveLength(1)

      insertWorkerDone(db, { taskId: task.id, from: 'term_a' })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })
  })

  describe('worktree-per-track reuse + serialization (F2 #13 slice 2)', () => {
    // Round 3 should-fix #3 (safe-by-default): two tasks on the same track with NO
    // dependency between them are not totally ordered — they could both be ready and
    // race into the shared worktree (review before implement). The run must REFUSE
    // such a DAG up front rather than rely on the operator remembering deps. Fails
    // without the guard: the run would proceed and arbitrarily order them.
    it('refuses to run when same-track tasks are not ordered by deps', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      db.createTask({ spec: 'implement feature\ntrack: feat-x' })
      db.createTask({ spec: 'review feature\ntrack: feat-x' }) // no deps → unsafe

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      await expect(coordinator.run()).rejects.toThrow(/totally ordered|deps/)
      // Nothing was dispatched — refusal happens before any worktree is created.
      expect(runtime.createdWorktrees).toHaveLength(0)
    })

    // The same unordered DAG is allowed on the legacy (non-worktree-backed) path —
    // legacy dispatch shares no worktree, so there is no collision to guard against.
    // The run must NOT reject at decompose (the guard is worktree-backed-only).
    it('does NOT apply the track-ordering guard on the legacy path', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

      db.createTask({ spec: 'implement feature\ntrack: feat-x' })
      db.createTask({ spec: 'review feature\ntrack: feat-x' }) // no deps, same track

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'wt1'
        // worktreeBacked omitted → legacy path, no guard
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })
      // The run started and dispatched without the decompose guard rejecting it.
      expect(runtime.sentMessages.length).toBeGreaterThan(0)
      expect(runtime.createdWorktrees).toHaveLength(0)
      coordinator.stop()
      await runPromise
    })

    // Slice-2 core: distinct tracks run concurrently up to maxConcurrent. Fails if
    // serialization is global (would dispatch one at a time) or if reuse keyed
    // tasks together incorrectly.
    it('distinct trackKeys: two worktrees dispatched concurrently under maxConcurrent', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const tA = db.createTask({ spec: 'work A\ntrack: alpha' })
      const tB = db.createTask({ spec: 'work B\ntrack: beta' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude',
        maxConcurrent: 2
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // Both distinct tracks dispatched in parallel: two worktrees, two in-flight.
      expect(runtime.createdWorktrees).toHaveLength(2)
      expect(db.listTasks({ status: 'dispatched' })).toHaveLength(2)
      const parents = new Set(runtime.createdWorktrees.map((w) => w.parentWorktreeId))
      expect(parents).toEqual(new Set(['director-wt']))
      const childTaskIds = new Set(runtime.createdWorktrees.map((w) => w.taskId))
      expect(childTaskIds).toEqual(new Set([tA.id, tB.id]))

      insertWorkerDone(db, { taskId: tA.id })
      insertWorkerDone(db, { taskId: tB.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // maxConcurrent still bounds distinct tracks: with a limit of 1, two distinct
    // tracks dispatch one-at-a-time (slot limit), not both at once.
    it('maxConcurrent bounds concurrent tracks (limit 1 → one worktree at a time)', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const tA = db.createTask({ spec: 'work A\ntrack: alpha' })
      const tB = db.createTask({ spec: 'work B\ntrack: beta' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'build it',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude',
        maxConcurrent: 1
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // Only one worktree/dispatch despite two distinct ready tracks (slot-bound).
      expect(runtime.createdWorktrees).toHaveLength(1)
      expect(db.listTasks({ status: 'dispatched' })).toHaveLength(1)

      const firstId = runtime.createdWorktrees[0].taskId!
      insertWorkerDone(db, { taskId: firstId })
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // After the first frees its slot, the second distinct track gets its worktree.
      expect(runtime.createdWorktrees).toHaveLength(2)

      const secondId = firstId === tA.id ? tB.id : tA.id
      insertWorkerDone(db, { taskId: secondId })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // The `track:` infra hint must not leak into the worker's --- TASK --- block.
    it('strips the track: hint from the dispatched preamble', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const task = db.createTask({ spec: 'do the work\ntrack: feat-x' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      const sent = runtime.sentMessages.find((m) => m.handle === 'term_wt_0')
      expect(sent).toBeDefined()
      expect(sent!.text).toContain('do the work')
      expect(sent!.text).not.toContain('track: feat-x')
      expect(sent!.text).not.toMatch(/^[ \t]*track:/im)

      insertWorkerDone(db, { taskId: task.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // Legacy (default-off) path also strips the hint and still dispatches to a
    // bare terminal — proving the strip is path-independent and the flag-off path
    // is unchanged for non-track specs.
    it('default-off path strips the track: hint and dispatches to a bare terminal', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [
        { handle: 'term_a', worktreeId: 'director-wt', connected: true, writable: true }
      ]

      const task = db.createTask({ spec: 'legacy work\ntrack: feat-x' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt'
        // worktreeBacked omitted → legacy bare-terminal path
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      expect(runtime.createdWorktrees).toHaveLength(0)
      const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
      expect(sent).toBeDefined()
      expect(sent!.text).toContain('legacy work')
      expect(sent!.text).not.toContain('track: feat-x')

      insertWorkerDone(db, { taskId: task.id, from: 'term_a' })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // Round 2 must-fix #1 (gate): the tui-idle readiness gate must also fire on a
    // REUSED agent terminal before the 2nd preamble — the same booting-TUI race.
    it('reuse path waits for tui-idle before the 2nd preamble (reused agent terminal)', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const t1 = db.createTask({ spec: 'implement\ntrack: feat-x' })
      const t2 = db.createTask({ spec: 'review\ntrack: feat-x', deps: [t1.id] })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })
      // deps ensure implement (t1) dispatches first; review (t2) is gated until done.
      const first = t1
      const second = t2
      insertWorkerDone(db, { taskId: first.id })
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // Both dispatches landed in the cached agent terminal, and each send was
      // preceded by a tui-idle wait on that handle (the 2nd wait before the 2nd send).
      const waitIdx = runtime.callOrder
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c === 'wait:term_wt_0')
        .map((x) => x.i)
      const sendIdx = runtime.callOrder
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c === 'send:term_wt_0')
        .map((x) => x.i)
      expect(waitIdx.length).toBeGreaterThanOrEqual(2)
      expect(sendIdx.length).toBe(2)
      expect(waitIdx[1]).toBeLessThan(sendIdx[1])

      insertWorkerDone(db, { taskId: second.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // Round 3 must-fix #1+#2: when the cached agent terminal is GONE, the reuse path
    // must relaunch a REAL agent via launchAgentTerminal (the actual spawn) — NOT
    // createTerminal({ launchAgent }), which only spawns a bare shell tagged as an
    // agent. Fails against the round-2 bare-shell code: that code called
    // createTerminal (never launchAgentTerminal), so launchAgentTerminalCalls is
    // empty and a shell would receive the agent preamble.
    it('relaunches a REAL worker agent (launchAgentTerminal) in the reused worktree when the cached terminal is gone', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const t1 = db.createTask({ spec: 'implement\ntrack: feat-x' })
      const t2 = db.createTask({ spec: 'review\ntrack: feat-x', deps: [t1.id] })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })
      insertWorkerDone(db, { taskId: t1.id })

      // Simulate implement's agent terminal exiting after its grace window: the
      // cached handle is no longer connected, so reuse cannot find it.
      runtime.terminals.find((t) => t.handle === 'term_wt_0')!.connected = false

      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // The worktree was NOT recreated; a REAL agent was relaunched in it via
      // launchAgentTerminal (NOT a bare-shell createTerminal).
      expect(runtime.createdWorktrees).toHaveLength(1)
      const relaunch = runtime.launchAgentTerminalCalls.find((c) => c.worktree === 'id:wt_child_0')
      expect(relaunch).toBeDefined()
      expect(relaunch!.agent).toBe('claude')
      // createTerminal (the bare-shell path) was NOT used to carry the agent.
      expect(runtime.createTerminalCalls).toHaveLength(0)
      // The relaunched agent terminal got a tui-idle wait before its preamble.
      const relaunchedHandle = 'term_agent_0'
      expect(runtime.callOrder.indexOf(`wait:${relaunchedHandle}`)).toBeLessThan(
        runtime.callOrder.indexOf(`send:${relaunchedHandle}`)
      )

      insertWorkerDone(db, { taskId: t2.id, from: relaunchedHandle })
      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(result.completedTasks).toContain(t2.id)
    })

    // Round 3 must-fix #1 / test-gap: if the agent relaunch can't be obtained
    // (launchAgentTerminal throws), the task must breaker-FAIL after strikes — never
    // hang — and the shared worktree must NOT be torn down (it holds the
    // predecessor's work). No preamble is ever sent into a non-agent terminal.
    it('breaker-fails (no hang) and preserves the shared worktree when the agent relaunch keeps failing', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const t1 = db.createTask({ spec: 'implement\ntrack: feat-x' })
      const t2 = db.createTask({ spec: 'review\ntrack: feat-x', deps: [t1.id] })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 10,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 60)
      })
      insertWorkerDone(db, { taskId: t1.id })

      // Cached terminal gone AND every agent relaunch attempt fails.
      runtime.terminals.find((t) => t.handle === 'term_wt_0')!.connected = false
      runtime.throwLaunchAgentTerminal = new Error('relaunch failed')

      const result = await runPromise

      expect(result.status).toBe('failed')
      expect(result.failedTasks).toContain(t2.id)
      expect(db.getTask(t2.id)?.status).toBe('failed')
      // The first task still completed, and its shared worktree was preserved.
      expect(result.completedTasks).toContain(t1.id)
      expect(runtime.createdWorktrees).toHaveLength(1)
      expect(runtime.removedWorktrees).toHaveLength(0)
      // The coordinator NEVER fell back to a bare shell for the agent dispatch.
      expect(runtime.createTerminalCalls).toHaveLength(0)
      expect(runtime.sentMessages.filter((m) => m.handle.startsWith('term_worker_'))).toHaveLength(
        0
      )
    })

    // Round 2 test-gap: the default (no `track:` hint) is per-task — two no-track
    // tasks must get DISTINCT worktrees (trackKey = task id). Previously only the
    // explicit-track distinct case was covered.
    it('two no-track tasks get distinct worktrees (default trackKey = task id)', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const t1 = db.createTask({ spec: 'plain work one' })
      const t2 = db.createTask({ spec: 'plain work two' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude',
        maxConcurrent: 2
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      expect(runtime.createdWorktrees).toHaveLength(2)
      const childTaskIds = new Set(runtime.createdWorktrees.map((w) => w.taskId))
      expect(childTaskIds).toEqual(new Set([t1.id, t2.id]))

      insertWorkerDone(db, { taskId: t1.id })
      insertWorkerDone(db, { taskId: t2.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
    })

    // Round 2 must-fix #2 (ordering, deps route): a same-track successor that
    // declares deps:[predecessor] runs implement-FIRST deterministically — it is
    // not even `ready` until implement completes, then reuses implement's worktree.
    it('same-track successor with deps:[predecessor] dispatches implement-first, then reuses', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const implement = db.createTask({ spec: 'implement\ntrack: feat-x' })
      const review = db.createTask({
        spec: 'review\ntrack: feat-x',
        deps: [implement.id]
      })

      // review must start blocked on implement (not ready).
      expect(db.getTask(review.id)?.status).toBe('pending')

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 30,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // Only implement dispatched first (review is still pending on its dep).
      expect(runtime.createdWorktrees).toHaveLength(1)
      expect(runtime.createdWorktrees[0].taskId).toBe(implement.id)
      expect(db.getTask(implement.id)?.status).toBe('dispatched')
      expect(db.getTask(review.id)?.status).toBe('pending')

      insertWorkerDone(db, { taskId: implement.id })
      await new Promise((r) => {
        setTimeout(r, 80)
      })

      // review now reuses implement's worktree (no new worktree), in the same
      // cached terminal — no bare terminal and no agent relaunch were needed.
      expect(runtime.createdWorktrees).toHaveLength(1)
      expect(runtime.createdTerminals).toHaveLength(0)
      expect(runtime.launchAgentTerminalCalls).toHaveLength(0)
      expect(runtime.sentMessages.filter((m) => m.handle === 'term_wt_0')).toHaveLength(2)

      insertWorkerDone(db, { taskId: review.id })
      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(result.completedTasks).toContain(implement.id)
      expect(result.completedTasks).toContain(review.id)
    })
  })

  describe('stale-base dispatch guard', () => {
    it('threads drift into the preamble when behind > 0 and under threshold', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      runtime.setProbeDrift({
        base: 'origin/main',
        behind: 5,
        recentSubjects: ['fix A', 'fix B', 'fix C']
      })

      const task = db.createTask({ spec: 'do the work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'wt1'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      insertWorkerDone(db, { taskId: task.id })

      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(runtime.probeDriftCalls).toContain('wt1')
      const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
      expect(sent).toBeDefined()
      expect(sent!.text).toContain('--- BASE DRIFT ---')
      expect(sent!.text).toContain('5 commits behind origin/main')
      expect(sent!.text).toContain('fix A')
    })

    it('silently skips dispatch when drift > threshold and allow-stale-base is absent', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      runtime.setProbeDrift({
        base: 'origin/main',
        behind: DISPATCH_STALE_THRESHOLD + 10,
        recentSubjects: ['fix A']
      })

      const task = db.createTask({ spec: 'do the work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'wt1'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 250)
      })
      coordinator.stop()
      const result = await runPromise

      // Why: silent-skip must NOT burn the circuit-breaker budget. Task must
      // stay in `ready`; failDispatch must NOT be called; sendTerminal must
      // NOT be called; no dispatch context should exist.
      expect(runtime.sentMessages).toHaveLength(0)
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getDispatchContext(task.id)).toBeUndefined()
      // Coordinator was stopped externally, so overall status is 'failed'
      // because tasks are not complete — but the task itself never dispatched.
      expect(result.status).toBe('failed')
      expect(result.failedTasks).not.toContain(task.id)
    })

    it('proceeds with stripped spec + drift section when allow-stale-base overrides', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      runtime.setProbeDrift({
        base: 'origin/main',
        behind: 200,
        recentSubjects: ['commit 1', 'commit 2']
      })

      const spec = `Investigate issue #42
allow-stale-base: true`
      const task = db.createTask({ spec })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'wt1'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      insertWorkerDone(db, { taskId: task.id })

      const result = await runPromise
      expect(result.status).toBe('completed')
      const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
      expect(sent).toBeDefined()
      expect(sent!.text).toContain('--- BASE DRIFT ---')
      expect(sent!.text).toContain('200 commits behind origin/main')
      // Why (§3.4): stripped spec must not contain the infra flag line.
      expect(sent!.text).toContain('Investigate issue #42')
      expect(sent!.text).not.toContain('allow-stale-base: true')
    })

    it('proceeds without drift section when probeWorktreeDrift returns null', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      runtime.setProbeDrift(null)

      const task = db.createTask({ spec: 'do the work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'wt1'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      insertWorkerDone(db, { taskId: task.id })

      const result = await runPromise
      expect(result.status).toBe('completed')
      const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
      expect(sent).toBeDefined()
      expect(sent!.text).not.toContain('--- BASE DRIFT ---')
    })

    it('does not call probeWorktreeDrift when coordinator has no worktree selector', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      const logs: string[] = []

      const task = db.createTask({ spec: 'do the work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        // worktree deliberately omitted
        onLog: (msg) => logs.push(msg)
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      insertWorkerDone(db, { taskId: task.id })

      const result = await runPromise
      expect(result.status).toBe('completed')
      expect(runtime.probeDriftCalls).toHaveLength(0)
      expect(logs.some((m) => m.includes('stale-base guard inert'))).toBe(true)
      // Dispatch still went through normally.
      expect(runtime.sentMessages.length).toBeGreaterThan(0)
    })

    it('proceeds without drift when probeWorktreeDrift throws', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
      runtime.throwProbeDrift = new Error('boom')

      const task = db.createTask({ spec: 'do the work' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 50,
        worktree: 'wt1'
      })

      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      insertWorkerDone(db, { taskId: task.id })

      const result = await runPromise
      expect(result.status).toBe('completed')
      const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
      expect(sent!.text).not.toContain('--- BASE DRIFT ---')
    })

    // F3 #14 (design §8): on resume-on-boot a worktree-backed run re-adopts its
    // existing track worktrees instead of recreating them. seedAdoptedTrackWorktrees
    // pre-seeds the track map; the next same-track dispatch must be a HIT (reuse the
    // existing checkout) — NO createWorktree, and because the cached handle is a
    // post-restart sentinel, the worker agent is relaunched IN the existing worktree.
    // Without the seeding this would create a brand-new worktree/branch (a duplicate).
    it('re-adopts a seeded track worktree on resume: no duplicate worktree, relaunches the agent', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()

      const task = db.createTask({ spec: 'track: alpha\nimplement the thing' })

      const coordinator = new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20,
        worktree: 'director-wt',
        worktreeBacked: true,
        workerAgent: 'claude'
      })
      // Simulate the boot reconciler re-seeding the track map from lineage.
      coordinator.seedAdoptedTrackWorktrees([
        [
          'alpha',
          { worktreeId: 'wt-existing', terminalHandle: 'orch-readopt:wt-existing', isAgent: true }
        ]
      ])

      const runPromise = coordinator.run()
      try {
        // Wait for the relaunch+dispatch on a CONDITION (not a fixed delay), then
        // converge before asserting — so a slow tick under load can't throw an
        // assertion before we await the loop, which would leave it ticking past
        // db teardown (an unhandled "database is not open" rejection).
        await waitFor(() => runtime.launchAgentTerminalCalls.length === 1)
        insertWorkerDone(db, { taskId: task.id, from: 'term_agent_0' })
        const result = await runPromise
        expect(result.status).toBe('completed')

        // Re-adopted, not recreated: no new worktree was forked for the track.
        expect(runtime.createdWorktrees).toHaveLength(0)
        // The dead pre-crash terminal handle forced a relaunch in the SAME checkout.
        expect(runtime.launchAgentTerminalCalls[0].worktree).toBe('id:wt-existing')
        // The dispatch preamble landed in the relaunched agent terminal.
        expect(runtime.sentMessages.some((m) => m.handle === 'term_agent_0')).toBe(true)
      } finally {
        // Always drain the loop so a failed assertion can never strand a ticking
        // coordinator past this test's db teardown.
        coordinator.stop()
        await runPromise.catch(() => {})
      }
    })
  })
})

describe('worktreeNameForTask', () => {
  it('builds a branch-safe slug from the title with a unique task-id suffix', () => {
    const name = worktreeNameForTask({
      id: 'task_abc123',
      spec: 'ignored',
      task_title: 'Implement the Bridge!'
    })
    expect(name).toBe('orch-implement-the-bridge-abc123')
    expect(name).toMatch(/^[a-z0-9-]+$/)
  })

  it('falls back to the spec first line when there is no title', () => {
    const name = worktreeNameForTask({
      id: 'task_def456',
      spec: 'Fix flaky test\nmore detail here',
      task_title: null
    })
    expect(name).toBe('orch-fix-flaky-test-def456')
  })

  it('uses only the task id when the source has no usable characters', () => {
    const name = worktreeNameForTask({ id: 'task_xyz789', spec: '!!! ???', task_title: null })
    expect(name).toBe('orch-xyz789')
  })
})

describe('parseAllowStaleBaseFromSpec', () => {
  it('matches canonical form on its own line and strips it', () => {
    const spec = `Do the work
allow-stale-base: true`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).toBe('Do the work\n')
    expect(strippedSpec).not.toContain('allow-stale-base')
  })

  it('matches case-insensitively', () => {
    const spec = `Do the work
Allow-Stale-Base: TRUE`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).not.toMatch(/[Aa]llow-[Ss]tale-[Bb]ase/)
  })

  it('does not match allow-stale-base: false', () => {
    const spec = `Do the work
allow-stale-base: false`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('does not match allow-stale-base: truthy', () => {
    const spec = `Do the work
allow-stale-base: truthy`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('does not match the flag embedded inside a sentence', () => {
    const spec = 'we allow-stale-base: true sometimes'
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('handles the flag as the last line with no trailing newline', () => {
    const spec = 'line 1\nallow-stale-base: true'
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).toBe('line 1\n')
    expect(strippedSpec.endsWith('allow-stale-base: true')).toBe(false)
  })
})

describe('parseTrackFromSpec', () => {
  it('captures the track key on its own line and strips it', () => {
    const spec = `Implement the bridge
track: feat-x`
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBe('feat-x')
    expect(strippedSpec).toBe('Implement the bridge\n')
    expect(strippedSpec).not.toContain('track:')
  })

  it('returns null when no track hint is present (caller defaults to task id)', () => {
    const spec = 'Just implement it'
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBeNull()
    expect(strippedSpec).toBe(spec)
  })

  it('matches case-insensitively and captures a task-id-style key', () => {
    const spec = `Review the change
Track: task_abc123`
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBe('task_abc123')
    expect(strippedSpec).not.toMatch(/[Tt]rack:/)
  })

  it('does not match the hint embedded inside a sentence', () => {
    const spec = 'we track: things sometimes'
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBeNull()
    expect(strippedSpec).toBe(spec)
  })

  it('handles the hint as the last line with no trailing newline', () => {
    const spec = 'line 1\ntrack: feat-x'
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBe('feat-x')
    expect(strippedSpec).toBe('line 1\n')
  })

  // Round 2 should-fix #3: a `track:` line inside a fenced code block (e.g. a
  // worker-instruction example) must NOT be parsed or stripped.
  it('ignores a track: hint inside a fenced code block', () => {
    const spec = ['Do the work', '```', 'track: not-a-real-track', '```'].join('\n')
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBeNull()
    expect(strippedSpec).toBe(spec)
  })

  it('captures the first non-fenced hint even when a fenced example precedes it', () => {
    const spec = ['Intro', '```', 'track: example-only', '```', 'track: real-track'].join('\n')
    const { trackKey, strippedSpec } = parseTrackFromSpec(spec)
    expect(trackKey).toBe('real-track')
    // The real (last, non-fenced) line is stripped; the fenced example is kept.
    expect(strippedSpec).toContain('track: example-only')
    expect(strippedSpec.endsWith('track: real-track')).toBe(false)
  })
})
