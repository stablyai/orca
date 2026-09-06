import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { transitionLifecycleWithDb } from './db/lifecycle-transition'

let db: OrchestrationDb | undefined
let directory: string | undefined

afterEach(() => {
  db?.close()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
  db = undefined
  directory = undefined
})

function createDatabase(): OrchestrationDb {
  directory = mkdtempSync(join(tmpdir(), 'orca-lifecycle-edges-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  return db
}

function startWorker(database: OrchestrationDb, taskId: string, name: string): string {
  const started = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: `term_${name}`,
    paneKey: `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${name.length.toString(16).padStart(12, '0')}`,
    processIncarnation: `${name}:1`,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerDispatchReady(started.dispatch.id)
  return started.dispatch.id
}

// (entity, from, to, call site) — every edge a production caller can request.
const CALLER_EDGES: [string, string, string, string][] = [
  ['worker', 'ready', 'failed', 'dispatch-completion.ts failDispatch workerProcessExited'],
  ['worker', 'starting', 'failed', 'dispatch-completion.ts'],
  ['worker', 'start_unknown', 'failed', 'dispatch-completion.ts'],
  ['worker', 'stopping', 'failed', 'dispatch-completion.ts'],
  ['worker', 'stop_unknown', 'failed', 'dispatch-completion.ts'],
  ['worker', 'ready', 'succeeded', 'worker-report-settlement.ts'],
  ['worker', 'start_unknown', 'failed', 'worker-report-settlement.ts'],
  ['worker', 'ready', 'stopping', 'worker-dispatch-stop.ts'],
  ['worker', 'start_unknown', 'stopping', 'worker-dispatch-stop.ts'],
  ['worker', 'stopping', 'stopped', 'worker-dispatch-stop.ts'],
  ['worker', 'stop_unknown', 'stopped', 'worker-dispatch-stop.ts'],
  ['worker', 'stopping', 'ready', 'worker-dispatch-stop.ts'],
  ['worker', 'starting', 'ready', 'worker-dispatch-outcome.ts'],
  ['worker', 'starting', 'start_unknown', 'worker-dispatch-outcome.ts'],
  ['worker', 'starting', 'abandoned', 'worker-terminal-recovery.ts'],
  ['worker', 'ready', 'abandoned', 'worker-dispatch-abandon.ts'],
  ['worker', 'start_unknown', 'abandoned', 'worker-dispatch-abandon.ts'],
  ['task', 'ready', 'dispatched', 'worker-dispatch-start.ts'],
  ['task', 'failed', 'dispatched', 'worker-dispatch-start.ts retry'],
  ['task', 'blocked', 'dispatched', 'worker-dispatch-start.ts retry'],
  ['task', 'dispatched', 'blocked', 'worker-dispatch-outcome.ts'],
  ['task', 'dispatched', 'completed', 'worker-report-settlement.ts'],
  ['task', 'completed', 'ready', 'task-status-transition.ts public task update'],
  ['task', 'completed', 'failed', 'task-status-transition.ts public task update'],
  ['task', 'failed', 'ready', 'task-status-transition.ts public task update'],
  ['dispatch', 'pending', 'completed', 'dispatch-completion.ts'],
  ['dispatch', 'dispatched', 'failed', 'dispatch-completion.ts'],
  ['dispatch', 'dispatched', 'circuit_broken', 'dispatch-completion.ts']
]

describe('lifecycle graph against its callers', () => {
  it('accepts every (from, to) a production call site can request', () => {
    const database = createDatabase()
    const sqlite = database.db
    sqlite.exec(
      `INSERT INTO tasks (id, spec, status) VALUES ('t1', 'x', 'ready');
       INSERT INTO dispatch_contexts (id, task_id, status, depth) VALUES ('c1', 't1', 'pending', 1);
       INSERT INTO worker_dispatches (dispatch_id, state, stage) VALUES ('c1', 'starting', 's');`
    )
    const entities: Record<string, { table: string; id: string; state: string }> = {
      task: { table: 'tasks', id: 'id', state: 'status' },
      dispatch: { table: 'dispatch_contexts', id: 'id', state: 'status' },
      worker: { table: 'worker_dispatches', id: 'dispatch_id', state: 'state' }
    }
    const rejected: string[] = []
    for (const [entity, from, to, site] of CALLER_EDGES) {
      const target = entities[entity]!
      const key = entity === 'task' ? 't1' : 'c1'
      sqlite
        .prepare(`UPDATE ${target.table} SET ${target.state} = ? WHERE ${target.id} = ?`)
        .run(from, key)
      try {
        transitionLifecycleWithDb(sqlite, { entity: entity as never, id: key, from, to })
      } catch (error) {
        rejected.push(`${entity} ${from} -> ${to} [${site}]: ${(error as Error).message}`)
      }
    }

    expect(rejected).toEqual([])
  })

  it('settles a stopping worker whose PTY exits during the stop', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'stopping exited worker' })
    const dispatchId = startWorker(database, task.id, 'stopping_exited')

    expect(database.beginWorkerStop(dispatchId, 'runtime_test').disposition).toBe('stopping')
    expect(database.getWorkerDispatch(dispatchId)?.state).toBe('stopping')

    // Real path: failActiveDispatchOnExit -> failDispatch({ workerProcessExited: true }).
    expect(() =>
      database.failDispatch(dispatchId, 'process exited', {
        workerProcessExited: true,
        terminationReason: 'exited'
      })
    ).not.toThrow()
    expect(database.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('still lets a coordinator reopen or overturn a settled Task', () => {
    const database = createDatabase()
    const reopened = database.createTask({ spec: 'reopen me' })
    const overturned = database.createTask({ spec: 'overturn me' })
    const retried = database.createTask({ spec: 'retry me' })
    database.updateTaskStatus(reopened.id, 'completed', 'first result')
    database.updateTaskStatus(overturned.id, 'completed', 'wrong result')
    database.updateTaskStatus(retried.id, 'failed', 'boom')

    expect(() => database.updateTaskStatus(reopened.id, 'ready')).not.toThrow()
    expect(() =>
      database.updateTaskStatus(overturned.id, 'failed', 'review overturned it')
    ).not.toThrow()
    expect(() => database.updateTaskStatus(retried.id, 'ready')).not.toThrow()
  })
})
