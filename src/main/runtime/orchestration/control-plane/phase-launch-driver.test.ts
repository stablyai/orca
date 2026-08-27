import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import { classifyWakeReason } from './coordinator-wake-events'
import {
  drivePhaseLaunches,
  phaseLaunchPayloadHash,
  type PhaseStartRequest,
  type PhaseStartResult,
  type PhaseWorkerStarter
} from './phase-launch-driver'
import { PHASE_LAUNCH_MAX_ATTEMPTS, PhaseLaunchStore } from './phase-launch-store'
import type { RouteIdentity } from './route-registry-types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const REVIEWER: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }
const BUILDER: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }

function starter(
  start: (request: PhaseStartRequest) => Promise<PhaseStartResult>,
  reconcile: (request: PhaseStartRequest) => Promise<{ dispatchId: string } | null> = async () =>
    null
): PhaseWorkerStarter {
  return { start, reconcile }
}

describe('correction 3: planning a Task is not enough — the driver starts it', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function plan(
    options: {
      kind?: 'review' | 'fix_first'
      route?: RouteIdentity
      terminalHandle?: string | null
    } = {}
  ) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review the commit' })
    const store = new PhaseLaunchStore(db)
    const row = store.recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: options.kind ?? 'review',
      route: options.route ?? REVIEWER,
      terminalHandle: options.terminalHandle ?? null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    return { store, task, row, runId: task.run_id }
  }

  it('bug-rejecting: a planned phase that is never driven stays unstarted', () => {
    const { store, row } = plan()
    // This is exactly the correction-2 gap: the Task and the phase exist, but no
    // session does. If the lifecycle ever regresses to "create only", this row
    // stays `pending` with no Dispatch, and this assertion is what catches it.
    expect(row.state).toBe('pending')
    expect(row.dispatch_id).toBeNull()
    expect(store.listActionable(row.run_id)).toHaveLength(1)
  })

  it('starts the reviewer exactly once and records its Dispatch', async () => {
    const { store, runId, task } = plan()
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_review' }) as const)
    const result = await drivePhaseLaunches({ db, runId, nowMs: NOW, starter: starter(start) })
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.launched).toEqual([
      expect.objectContaining({
        taskId: task.id,
        kind: 'review',
        state: 'started',
        dispatchId: 'ctx_review'
      })
    ])
    expect(store.getByTask(task.id)).toMatchObject({ state: 'started', dispatch_id: 'ctx_review' })
  })

  it('bug-rejecting: replaying the drive creates zero duplicate launches', async () => {
    const { store, runId } = plan()
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_review' }) as const)
    await drivePhaseLaunches({ db, runId, nowMs: NOW, starter: starter(start) })
    await drivePhaseLaunches({ db, runId, nowMs: NOW + 1_000, starter: starter(start) })
    await drivePhaseLaunches({ db, runId, nowMs: NOW + 2_000, starter: starter(start) })
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.list(runId)).toHaveLength(1)
  })

  it('bug-rejecting: replaying the plan itself cannot fork a second launch row', () => {
    const { store, row, task, runId } = plan()
    const again = store.recordPlanned({
      phaseId: row.phase_id,
      runId,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    expect(again.phase_id).toBe(row.phase_id)
    expect(store.list(runId)).toHaveLength(1)
  })

  it('sends the FIX_FIRST launch to the original retained builder terminal exactly once', async () => {
    const { runId, task } = plan({
      kind: 'fix_first',
      route: BUILDER,
      terminalHandle: 'term_builder'
    })
    const seen: PhaseStartRequest[] = []
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW,
      starter: starter(async (request) => {
        seen.push(request)
        return { kind: 'started', dispatchId: 'ctx_fix' }
      })
    })
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW + 1_000,
      starter: starter(async (request) => {
        seen.push(request)
        return { kind: 'started', dispatchId: 'ctx_fix_2' }
      })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      kind: 'fix_first',
      terminalHandle: 'term_builder',
      route: { agent: 'claude', model: 'opus-5', reasoning: 'high' },
      taskId: task.id
    })
    expect(new PhaseLaunchStore(db).getByTask(task.id)?.dispatch_id).toBe('ctx_fix')
  })

  it('binds the reviewer to the worktree holding the reviewed commit', async () => {
    const { runId } = plan()
    let captured: PhaseStartRequest | undefined
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW,
      starter: starter(async (request) => {
        captured = request
        return { kind: 'started', dispatchId: 'ctx_1' }
      })
    })
    expect(captured?.worktreeId).toBe('repo::wt')
  })

  it('bug-rejecting: two concurrent drivers start the phase exactly once', async () => {
    const { runId, store } = plan()
    let inFlight = 0
    let maxInFlight = 0
    const start = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { kind: 'started', dispatchId: `ctx_${start.mock.calls.length}` } as const
    })
    // Both drivers read the same `pending` row before either claims it. Only the
    // writer whose conditional UPDATE actually changed a row may start.
    await Promise.all([
      drivePhaseLaunches({ db, runId, nowMs: NOW, starter: starter(start) }),
      drivePhaseLaunches({ db, runId, nowMs: NOW, starter: starter(start) })
    ])
    expect(start).toHaveBeenCalledTimes(1)
    expect(maxInFlight).toBe(1)
    expect(store.list(runId)).toHaveLength(1)
  })

  it('carries the phase id as the durable request id, so a retry presents the same request', async () => {
    const { runId, row } = plan()
    let captured: PhaseStartRequest | undefined
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW,
      starter: starter(async (request) => {
        captured = request
        return { kind: 'started', dispatchId: 'ctx_1' }
      })
    })
    expect(captured?.mutationRequestId).toBe(`phase_launch:${row.phase_id}`)
    expect(captured?.payloadHash).toBe(phaseLaunchPayloadHash(row))
  })
})

describe('correction 3: a lost worker-start response never creates a replacement', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function plan() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    new PhaseLaunchStore(db).recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    return { task, runId: task.run_id }
  }

  it('parks an unknown outcome as start_unknown and reconciles it to the original Dispatch', async () => {
    const { runId, task } = plan()
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW,
      starter: starter(async () => ({ kind: 'unknown', reason: 'socket closed' }))
    })
    const store = new PhaseLaunchStore(db)
    expect(store.getByTask(task.id)).toMatchObject({ state: 'start_unknown', attempts: 1 })

    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_replacement' }) as const)
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW + 1_000,
      // The previous attempt really had created this Dispatch; reconcile must
      // adopt it rather than let a second start run.
      starter: starter(start, async () => ({ dispatchId: 'ctx_original' }))
    })
    expect(start).not.toHaveBeenCalled()
    expect(store.getByTask(task.id)).toMatchObject({
      state: 'started',
      dispatch_id: 'ctx_original'
    })
  })

  it('bug-rejecting: a thrown start is unknown, not failed, so it can still reconcile', async () => {
    const { runId, task } = plan()
    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW,
      starter: starter(async () => {
        throw new Error('transport died')
      })
    })
    expect(new PhaseLaunchStore(db).getByTask(task.id)?.state).toBe('start_unknown')
  })

  it('fails closed after the attempt budget instead of starting another session', async () => {
    const { runId, task } = plan()
    const unknown = starter(async () => ({ kind: 'unknown', reason: 'still lost' }))
    for (let attempt = 0; attempt < PHASE_LAUNCH_MAX_ATTEMPTS + 1; attempt += 1) {
      await drivePhaseLaunches({ db, runId, nowMs: NOW + attempt * 1_000, starter: unknown })
    }
    const row = new PhaseLaunchStore(db).getByTask(task.id)
    expect(row?.state).toBe('failed')
    expect(row?.dispatch_id).toBeNull()
    // Terminal: a failed launch is no longer actionable, so no further start runs.
    expect(new PhaseLaunchStore(db).listActionable(runId)).toEqual([])
  })
})

describe('correction 3: an uncertified role emits the protected blocker', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('blocks and wakes the coordinator rather than falling back to another route', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    new PhaseLaunchStore(db).recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    const notify = vi.fn()
    const result = await drivePhaseLaunches({
      db,
      runId: task.run_id,
      nowMs: NOW,
      notify,
      starter: starter(async () => ({
        kind: 'blocked',
        reason: 'route_not_certified: route_stale'
      }))
    })
    expect(new PhaseLaunchStore(db).getByTask(task.id)?.state).toBe('blocked')
    expect(result.blockerMessageIds).toHaveLength(1)
    const message = db.getMessageById(result.blockerMessageIds[0])
    expect(message?.subject).toContain('Protected blocker')
    expect(JSON.parse(message?.payload as string).protectedBlocker).toBe(true)
    expect(classifyWakeReason(message!)).toBe('escalation')
    expect(notify).toHaveBeenCalledWith(`run:${task.run_id}`, 'escalation')
  })

  it('blocks a phase with no bound route instead of choosing one', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    db.db
      .prepare(
        `INSERT INTO control_plane_phase_launches
           (phase_id, run_id, outcome_id, task_id, kind, state, bound_sha)
         VALUES (?, ?, 'out_1', ?, 'review', 'pending', 'abc1234')`
      )
      .run(`phase_${task.id}`, task.run_id, task.id)
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_x' }) as const)
    const result = await drivePhaseLaunches({
      db,
      runId: task.run_id,
      nowMs: NOW,
      starter: starter(start)
    })
    expect(start).not.toHaveBeenCalled()
    expect(new PhaseLaunchStore(db).getByTask(task.id)?.state).toBe('blocked')
    expect(result.blockerMessageIds).toHaveLength(1)
  })
})

describe('correction 3: a blocked phase resumes once the route is certified', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function plan() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    new PhaseLaunchStore(db).recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    return { task, runId: task.run_id }
  }

  it('publishes the blocker once, then starts when the route becomes certified', async () => {
    const { runId, task } = plan()
    const blocked = starter(async () => ({
      kind: 'blocked' as const,
      reason: 'route_not_certified: route_untested'
    }))
    const first = await drivePhaseLaunches({ db, runId, nowMs: NOW, starter: blocked })
    const second = await drivePhaseLaunches({ db, runId, nowMs: NOW + 1_000, starter: blocked })
    expect(first.blockerMessageIds).toHaveLength(1)
    // Re-published every tick would spam the coordinator's wake set.
    expect(second.blockerMessageIds).toEqual([])

    // A blocked phase never burns the retry budget, because the block is an
    // external condition rather than a failing launch.
    expect(new PhaseLaunchStore(db).getByTask(task.id)).toMatchObject({
      state: 'blocked',
      attempts: 0
    })

    await drivePhaseLaunches({
      db,
      runId,
      nowMs: NOW + 2_000,
      starter: starter(async () => ({ kind: 'started', dispatchId: 'ctx_now_certified' }))
    })
    expect(new PhaseLaunchStore(db).getByTask(task.id)).toMatchObject({
      state: 'started',
      dispatch_id: 'ctx_now_certified'
    })
  })

  it('bug-rejecting: a failed phase stays terminal and is never restarted', async () => {
    const { runId, task } = plan()
    const store = new PhaseLaunchStore(db)
    const unknown = starter(async () => ({ kind: 'unknown' as const, reason: 'lost' }))
    for (let attempt = 0; attempt < PHASE_LAUNCH_MAX_ATTEMPTS + 1; attempt += 1) {
      await drivePhaseLaunches({ db, runId, nowMs: NOW + attempt * 1_000, starter: unknown })
    }
    expect(store.getByTask(task.id)?.state).toBe('failed')
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_late' }) as const)
    await drivePhaseLaunches({ db, runId, nowMs: NOW + 99_000, starter: starter(start) })
    expect(start).not.toHaveBeenCalled()
    expect(store.getByTask(task.id)?.state).toBe('failed')
  })
})

/** PARTIAL_START_WITH_NO_ROUTE_STRANDS_ITS_DISPATCH — a phase whose route was
 *  cleared but whose Dispatch already exists was routed to `blocked` before
 *  reconcile ran, reporting a live worker as one that never started. */
describe('correction 3: a started phase is never reported as blocked', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function startedThenRouteless(clearRoute: boolean) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    const store = new PhaseLaunchStore(db)
    store.recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    // A partial start: the Dispatch exists, but the row was re-opened and its
    // route lost before the driver could record the outcome.
    db.db
      .prepare(
        `UPDATE control_plane_phase_launches
         SET dispatch_id = 'ctx_partial', state = 'pending'${clearRoute ? ', agent = NULL' : ''}
         WHERE phase_id = ?`
      )
      .run(`phase_${task.id}`)
    return { task, runId: task.run_id, store }
  }

  it('adopts the existing Dispatch instead of blocking the phase', async () => {
    const { runId, task, store } = startedThenRouteless(true)
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_second' }) as const)
    await drivePhaseLaunches({ db, runId, nowMs: NOW, starter: starter(start) })
    expect(store.getByTask(task.id)).toMatchObject({
      state: 'started',
      dispatch_id: 'ctx_partial'
    })
    // The whole point: no second session for work already running.
    expect(start).not.toHaveBeenCalled()
  })

  it('negative control: a routeless phase with no Dispatch is still blocked', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'review' })
    const store = new PhaseLaunchStore(db)
    store.recordPlanned({
      phaseId: `phase_${task.id}`,
      runId: task.run_id,
      outcomeId: 'out_1',
      taskId: task.id,
      kind: 'review',
      route: REVIEWER,
      terminalHandle: null,
      worktreeId: 'repo::wt',
      boundSha: 'a1b2c3d4e5f6'
    })
    db.db
      .prepare(`UPDATE control_plane_phase_launches SET agent = NULL WHERE phase_id = ?`)
      .run(`phase_${task.id}`)
    const start = vi.fn(async () => ({ kind: 'started', dispatchId: 'ctx_never' }) as const)
    await drivePhaseLaunches({ db, runId: task.run_id, nowMs: NOW, starter: starter(start) })
    expect(start).not.toHaveBeenCalled()
    expect(store.getByTask(task.id)).toMatchObject({ state: 'blocked', dispatch_id: null })
  })
})
