import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import type { CoordinatorRuntime } from '../../orchestration/coordinator'
import { runOrchestrationBootReconcile } from './orchestration-gates'
import type { WorktreeLineage } from '../../../../shared/types'

// Why (F3 #14, round 2 #2): the round-1 tests only ran `reconcileCoordinatorRunsOnBoot`
// in MUST-only mode (no resume fn), so the PRODUCTION callback `resumeCoordinatorRunOnBoot`
// (claim → guards → reclaim → v9 rebuild → lineage→adopt→seed → loop fire → .catch) was
// never exercised — which is why the catch-less-loop hard-rule bug shipped green. These
// drive the real callback via `runOrchestrationBootReconcile`. They FAIL against round-1
// code (catch-less loop leaves the run 'running'; NULL worktree_backed resumes legacy).

type Terminal = { handle: string; worktreeId: string; connected: boolean; writable: boolean }

type FakeRuntime = CoordinatorRuntime & {
  getOrchestrationDb(): OrchestrationDb
  resolveOrchestrationTargetKey(selector?: string): Promise<string | null>
  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>>
  getStartedAt(): number
  // probes
  createdWorktrees: { name: string }[]
  launchAgentCalls: { worktree: string }[]
  sent: { handle: string }[]
}

function makeRuntime(opts: {
  db: OrchestrationDb
  lineage?: Record<string, WorktreeLineage>
  resolveTarget?: (selector?: string) => Promise<string | null>
  startedAt?: number
}): FakeRuntime {
  const terminals: Terminal[] = []
  const rt: FakeRuntime = {
    createdWorktrees: [],
    launchAgentCalls: [],
    sent: [],
    getOrchestrationDb: () => opts.db,
    getStartedAt: () => opts.startedAt ?? 1_000_000,
    resolveOrchestrationTargetKey:
      opts.resolveTarget ?? (async (selector?: string) => `key:${selector ?? ''}`),
    listWorktreeLineage: async () => opts.lineage ?? {},
    async sendTerminal(handle: string) {
      rt.sent.push({ handle })
      return { handle, accepted: true }
    },
    async listTerminals() {
      return { terminals }
    },
    async createTerminal(worktree?: string) {
      const handle = `term_${terminals.length}`
      const worktreeId = worktree?.replace(/^id:/, '') ?? 'wt'
      terminals.push({ handle, worktreeId, connected: true, writable: true })
      return { handle, worktreeId }
    },
    async launchAgentTerminal(worktree: string) {
      rt.launchAgentCalls.push({ worktree })
      const handle = `term_agent_${rt.launchAgentCalls.length - 1}`
      terminals.push({
        handle,
        worktreeId: worktree.replace(/^id:/, ''),
        connected: true,
        writable: true
      })
      return { handle, worktreeId: worktree.replace(/^id:/, '') }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'tui-idle' }
    },
    async probeWorktreeDrift() {
      return null
    },
    async createWorktree(o: { name: string }) {
      rt.createdWorktrees.push({ name: o.name })
      const worktreeId = `wt_new_${rt.createdWorktrees.length}`
      const handle = `term_new_${rt.createdWorktrees.length}`
      terminals.push({ handle, worktreeId, connected: true, writable: true })
      return { worktreeId, branch: o.name, terminalHandle: handle }
    },
    async removeWorktree() {}
  }
  return rt
}

function lineageChild(p: {
  worktreeId: string
  parentWorktreeId: string
  orchestrationRunId: string
  taskId: string
}): WorktreeLineage {
  return {
    worktreeId: p.worktreeId,
    worktreeInstanceId: `${p.worktreeId}-inst`,
    parentWorktreeId: p.parentWorktreeId,
    parentWorktreeInstanceId: `${p.parentWorktreeId}-inst`,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    orchestrationRunId: p.orchestrationRunId,
    taskId: p.taskId,
    createdAt: 0
  }
}

function completeDispatchedTask(db: OrchestrationDb, taskId: string): void {
  const dispatch = db.getDispatchContext(taskId)
  if (!dispatch) {
    throw new Error(`no dispatch for ${taskId}`)
  }
  db.insertMessage({
    from: dispatch.assignee_handle ?? 'term',
    to: 'coord',
    subject: 'done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId: dispatch.id })
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise((r) => {
      setTimeout(r, 5)
    })
  }
}

describe('runOrchestrationBootReconcile — real resume path (F3 #14 round 2)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('resumes a worktree-backed run and re-adopts its track worktree (no duplicate)', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      targetKey: 'worktree:director',
      pollIntervalMs: 10,
      worktreeBacked: true,
      workerAgent: 'claude'
    })
    const task = d.createTask({
      spec: 'track: alpha\nimplement',
      coordinatorRunId: run.id,
      targetKey: 'worktree:director'
    })
    const runtime = makeRuntime({
      db: d,
      lineage: {
        alphaChild: lineageChild({
          worktreeId: 'wt-existing',
          parentWorktreeId: 'director',
          orchestrationRunId: run.id,
          taskId: task.id
        })
      }
    })

    const results = await runOrchestrationBootReconcile(runtime)
    expect(results[0].disposition).toBe('resumed')

    // The loop relaunched the agent in the EXISTING checkout — no new worktree forked.
    await waitFor(() => runtime.launchAgentCalls.length === 1)
    expect(runtime.createdWorktrees).toHaveLength(0)
    expect(runtime.launchAgentCalls[0].worktree).toBe('id:wt-existing')

    // Drive it to convergence so the run leaves 'running' cleanly.
    completeDispatchedTask(d, task.id)
    await waitFor(() => d.getCoordinatorRun(run.id)?.status === 'completed')
  })

  it('HARD RULE: a throwing pre-loop DB call ends the run failed, never left running', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      targetKey: 'worktree:director',
      pollIntervalMs: 10,
      worktreeBacked: true,
      workerAgent: 'claude'
    })
    d.createTask({ spec: 'A', coordinatorRunId: run.id, targetKey: 'worktree:director' })
    // Simulate a transient failure on the loop's first DB call (adoptUnownedTasks
    // runs at the top of executeLoop). Round-1 code ran it OUTSIDE the try and had
    // no .catch on the detached loop → the run was left 'running' with no loop.
    d.adoptUnownedTasks = () => {
      throw new Error('adopt boom')
    }
    const runtime = makeRuntime({ db: d })

    const results = await runOrchestrationBootReconcile(runtime)
    // resume() returns 'resumed' (the loop was fired) — but the loop must converge
    // the run to failed, never leave it running.
    expect(results[0].disposition).toBe('resumed')
    await waitFor(() => d.getCoordinatorRun(run.id)?.status === 'failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('declines (→ failed) a pre-v9 run whose worktree_backed is unknown (NULL)', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    // No worktreeBacked passed → stored NULL (simulating a pre-v9 row with a target).
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      targetKey: 'worktree:director',
      pollIntervalMs: 10
    })
    d.createTask({ spec: 'A', coordinatorRunId: run.id, targetKey: 'worktree:director' })
    const runtime = makeRuntime({ db: d })

    const results = await runOrchestrationBootReconcile(runtime)
    // Round-1 code resumed NULL as legacy (→ 'resumed', stays running). Now: failed.
    expect(results[0].disposition).toBe('failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
    expect(runtime.launchAgentCalls).toHaveLength(0)
  })

  it('declines (→ failed) when the director worktree no longer resolves', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      targetKey: 'worktree:gone',
      pollIntervalMs: 10,
      worktreeBacked: true,
      workerAgent: 'claude'
    })
    d.createTask({ spec: 'A', coordinatorRunId: run.id, targetKey: 'worktree:gone' })
    const runtime = makeRuntime({
      db: d,
      resolveTarget: async () => {
        throw new Error('worktree_not_found')
      }
    })

    const results = await runOrchestrationBootReconcile(runtime)
    expect(results[0].disposition).toBe('failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('declines (→ failed) a run with no worktree target', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10
    })
    d.createTask({ spec: 'A', coordinatorRunId: run.id })
    const runtime = makeRuntime({ db: d })

    const results = await runOrchestrationBootReconcile(runtime)
    expect(results[0].disposition).toBe('failed')
    expect(d.getCoordinatorRun(run.id)?.status).toBe('failed')
  })

  it('does not double-drive: a second runtime at the same boot fence is contended → skipped', async () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const run = d.startCoordinatorRun({
      spec: 'go',
      coordinatorHandle: 'coord',
      targetKey: 'worktree:director',
      pollIntervalMs: 10,
      worktreeBacked: true,
      workerAgent: 'claude'
    })
    const task = d.createTask({
      spec: 'track: alpha\nimplement',
      coordinatorRunId: run.id,
      targetKey: 'worktree:director'
    })
    const lineage = {
      alphaChild: lineageChild({
        worktreeId: 'wt-existing',
        parentWorktreeId: 'director',
        orchestrationRunId: run.id,
        taskId: task.id
      })
    }
    // Same boot fence for both runtimes → the second's atomic claim must lose.
    const rtA = makeRuntime({ db: d, lineage, startedAt: 5_000_000 })
    const rtB = makeRuntime({ db: d, lineage, startedAt: 5_000_000 })

    const a = await runOrchestrationBootReconcile(rtA)
    expect(a[0].disposition).toBe('resumed')
    await waitFor(() => rtA.launchAgentCalls.length === 1)

    // Second runtime reconciles the SAME still-running run: must hand off, not drive.
    const b = await runOrchestrationBootReconcile(rtB)
    expect(b[0].disposition).toBe('skipped')
    expect(rtB.launchAgentCalls).toHaveLength(0)
    expect(d.getCoordinatorRun(run.id)?.status).toBe('running')

    // Clean up the live loop.
    completeDispatchedTask(d, task.id)
    await waitFor(() => d.getCoordinatorRun(run.id)?.status === 'completed')
  })
})
