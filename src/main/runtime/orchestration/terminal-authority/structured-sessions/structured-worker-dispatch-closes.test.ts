import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  takeStructuredWorkerDispatchEnds,
  watchStructuredWorkerDispatchEnds
} from './structured-worker-dispatch-closes'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

function dispatchTo(orchestration: OrchestrationDb, runId: string, incarnation: string) {
  const task = orchestration.createTask({ runId, spec: incarnation })
  const dispatch = orchestration.createDispatchContext({
    taskId: task.id,
    assigneeHandle: `term_${incarnation}`,
    creator: { kind: 'system' },
    maxDepth: 9
  })
  orchestration.db
    .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
    .run(incarnation, dispatch.id)
  return dispatch.id
}

it('names a structured worker once when its Dispatch ends, moves, loses custody or is reset, and nothing for other changes', () => {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'workers',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  })
  const completed = dispatchTo(db, run.id, 'structured:worker-a')
  const failed = dispatchTo(db, run.id, 'structured:worker-b')
  const terminal = dispatchTo(db, run.id, 'pty:terminal-worker:1')
  const moved = dispatchTo(db, run.id, 'structured:worker-c')
  const released = dispatchTo(db, run.id, 'structured:worker-d')
  dispatchTo(db, run.id, 'structured:worker-f')
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation)
       VALUES ('resource-d', ?, ?, 'term_d', 'structured:worker-d')`
    )
    .run(released, released)
  db.completeDispatch(dispatchTo(db, run.id, 'structured:before-watching'))
  watchStructuredWorkerDispatchEnds(db)
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual([])

  db.createTask({ runId: run.id, spec: 'unrelated' })
  db.completeDispatch(terminal)
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual([])

  db.completeDispatch(completed)
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual(['structured:worker-a'])
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual([])

  db.failDispatch(failed, 'worker exited')
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual(['structured:worker-b'])

  db.db
    .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
    .run('structured:worker-e', moved)
  db.db
    .prepare("UPDATE worker_terminal_resources SET ownership_state = 'released' WHERE id = ?")
    .run('resource-d')
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual([
    'structured:worker-c',
    'structured:worker-d'
  ])

  // A reset removes every Dispatch, and names each structured worker whose open one it removed.
  db.resetAll()
  expect(takeStructuredWorkerDispatchEnds(db).toSorted()).toEqual([
    'structured:worker-d',
    'structured:worker-e',
    'structured:worker-f'
  ])
})
