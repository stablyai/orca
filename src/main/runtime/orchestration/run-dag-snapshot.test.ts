import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { MessageRow } from './types'
import {
  buildRunDagSnapshot,
  indexLatestWorkerSignals,
  RUN_DAG_SIGNAL_SCAN_LIMIT,
  type TaskWithDispatchRow
} from './run-dag-snapshot'

const STALE_THRESHOLD = '2026-01-01T00:00:00.000Z'

function taskRow(overrides: Partial<TaskWithDispatchRow>): TaskWithDispatchRow {
  return {
    id: 'task_1',
    parent_id: null,
    created_by_terminal_handle: null,
    coordinator_run_id: 'run_1',
    target_key: 'repo:/x',
    task_title: 'Implement auth',
    display_name: null,
    spec: 'Implement auth',
    status: 'ready',
    deps: '[]',
    result: null,
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    assignee_handle: null,
    dispatch_id: null,
    dispatch_status: null,
    dispatch_last_heartbeat_at: null,
    dispatch_dispatched_at: null,
    ...overrides
  }
}

function message(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'msg_1',
    from_handle: 'term_worker',
    to_handle: 'term_coord',
    subject: '',
    body: '',
    type: 'heartbeat',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    delivered_at: null,
    ...overrides
  }
}

const resolveAgent = (handle: string): 'codex' | 'claude' | null =>
  handle === 'term_codex' ? 'codex' : handle === 'term_claude' ? 'claude' : null

describe('indexLatestWorkerSignals', () => {
  it('keeps the latest signal per task (messages newest-first)', () => {
    // Newest-first ordering (sequence DESC), as getAllMessagesForHandle returns.
    const signals = indexLatestWorkerSignals([
      message({
        sequence: 3,
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', phase: 'reviewing' })
      }),
      message({
        sequence: 2,
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', phase: 'implementing' })
      })
    ])
    expect(signals.get('task_1')).toEqual({ phase: 'reviewing', summary: null })
  })

  it('captures a worker_done summary from the subject', () => {
    const signals = indexLatestWorkerSignals([
      message({
        type: 'worker_done',
        subject: 'Done: token refresh',
        body: 'Implemented refresh. Tests pass. Nothing left.',
        payload: JSON.stringify({ dispatchId: 'ctx_2', taskId: 'task_2' })
      })
    ])
    expect(signals.get('task_2')).toEqual({ phase: null, summary: 'Done: token refresh' })
  })

  it('ignores messages without a taskId', () => {
    const signals = indexLatestWorkerSignals([
      message({ type: 'heartbeat', payload: JSON.stringify({ phase: 'x' }) }),
      message({ type: 'heartbeat', payload: 'not json' })
    ])
    expect(signals.size).toBe(0)
  })
})

describe('buildRunDagSnapshot', () => {
  it('maps a dispatched task with a live heartbeat to a working dispatch', () => {
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [
        taskRow({
          id: 'task_a',
          status: 'dispatched',
          assignee_handle: 'term_codex',
          dispatch_id: 'ctx_a',
          dispatch_status: 'dispatched',
          dispatch_dispatched_at: '2025-06-01T00:00:00.000Z', // past the grace
          dispatch_last_heartbeat_at: '2026-06-01T00:00:00.000Z' // fresh (> threshold)
        })
      ],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map([['task_a', { phase: 'implementing', summary: null }]]),
      resolveAgent
    })
    expect(dag.tasks).toHaveLength(1)
    const node = dag.tasks[0]!
    expect(node.dispatch).toEqual({
      assigneeHandle: 'term_codex',
      assigneeAgent: 'codex',
      status: 'dispatched',
      lastHeartbeatAt: '2026-06-01T00:00:00.000Z',
      stale: false
    })
    expect(node.signal).toEqual({ phase: 'implementing', summary: null })
  })

  it('flags a dispatched task as stale when dispatched-at and heartbeat both predate the threshold', () => {
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [
        taskRow({
          status: 'dispatched',
          assignee_handle: 'term_codex',
          dispatch_id: 'ctx_a',
          dispatch_status: 'dispatched',
          dispatch_dispatched_at: '2024-01-01T00:00:00.000Z', // past the grace
          dispatch_last_heartbeat_at: '2025-01-01T00:00:00.000Z' // older than threshold
        })
      ],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    expect(dag.tasks[0]!.dispatch?.stale).toBe(true)
  })

  it('does NOT flag a freshly-dispatched worker (null heartbeat, within grace) as stale (#4)', () => {
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [
        taskRow({
          status: 'dispatched',
          assignee_handle: 'term_codex',
          dispatch_id: 'ctx_a',
          dispatch_status: 'dispatched',
          dispatch_dispatched_at: '2026-06-01T00:00:00.000Z', // within grace (> threshold)
          dispatch_last_heartbeat_at: null // no heartbeat yet
        })
      ],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    // Aggregate getStaleDispatches would also report 0 here — they must agree.
    expect(dag.tasks[0]!.dispatch?.stale).toBe(false)
  })

  it('parses deps and leaves a queued task with no dispatch', () => {
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [taskRow({ id: 'task_b', status: 'pending', deps: '["task_a"]' })],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    expect(dag.tasks[0]!.deps).toEqual(['task_a'])
    expect(dag.tasks[0]!.dispatch).toBeNull()
    expect(dag.tasks[0]!.signal).toBeNull()
  })

  it('falls back to the task id when the title would be blank (nit)', () => {
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [taskRow({ id: 'task_blank', spec: '   ', task_title: null, display_name: null })],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    expect(dag.tasks[0]!.title).toBe('task_blank')
  })

  it('caps tasks and reports the truncated count', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => taskRow({ id: `task_${i}` }))
    const dag = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks,
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent,
      taskCap: 2
    })
    expect(dag.tasks).toHaveLength(2)
    expect(dag.truncatedTaskCount).toBe(3)
  })

  it('passes the recipe through (mode-agnostic: null for LLM directors)', () => {
    const llm = buildRunDagSnapshot({
      runId: 'run_1',
      recipe: null,
      tasks: [],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    expect(llm.recipe).toBeNull()
    const recipe = buildRunDagSnapshot({
      runId: 'run_2',
      recipe: 'implement_then_review',
      tasks: [],
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId: new Map(),
      resolveAgent
    })
    expect(recipe.recipe).toBe('implement_then_review')
  })
})

// Why (#3): drive the REAL listTasksWithDispatch join + getAllMessagesForHandle +
// indexLatestWorkerSignals pipeline against an in-memory DB. The join surfaces
// only pending/dispatched dispatches, so a COMPLETED task's row has
// dispatch_id = null — a dispatch-keyed signal would never land. This fails
// against the pre-fix (dispatch-keyed) code and passes once signals key by task.
describe('worker_done summary reaches a completed task (real join)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  it('lands the worker_done summary on the completed row', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createCoordinatorRun({ spec: 'ship it', coordinatorHandle: 'term_coord' })
    const task = db.createTask({ spec: 'implement auth', coordinatorRunId: run.id })
    const ctx = db.createDispatchContext(task.id, 'term_worker')
    // The worker reports done, then the task is marked completed (dispatch closes).
    db.insertMessage({
      from: 'term_worker',
      to: 'term_coord',
      subject: 'Done: token refresh',
      body: 'Implemented refresh.',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: ctx.id })
    })
    db.updateTaskStatus(task.id, 'completed')

    const tasks = db.listTasksWithDispatch({ coordinatorRunId: run.id })
    const completedRow = tasks.find((t) => t.id === task.id)!
    // Precondition: the completed row has no active dispatch (the bug's setup).
    expect(completedRow.dispatch_id).toBeNull()

    const signalsByTaskId = indexLatestWorkerSignals(
      db.getAllMessagesForHandle('term_coord', RUN_DAG_SIGNAL_SCAN_LIMIT, [
        'heartbeat',
        'worker_done'
      ])
    )
    const dag = buildRunDagSnapshot({
      runId: run.id,
      recipe: null,
      tasks,
      staleThresholdIso: STALE_THRESHOLD,
      signalsByTaskId,
      resolveAgent
    })
    const node = dag.tasks.find((t) => t.id === task.id)!
    expect(node.status).toBe('completed')
    expect(node.signal).toEqual({ phase: null, summary: 'Done: token refresh' })
  })
})
