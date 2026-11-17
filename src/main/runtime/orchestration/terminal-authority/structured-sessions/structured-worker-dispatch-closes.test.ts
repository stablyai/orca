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

it('names a structured worker once when its Dispatch ends, moves or is removed, and nothing for other changes', () => {
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
  const removed = dispatchTo(db, run.id, 'structured:worker-d')
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
  db.db.prepare('DELETE FROM dispatch_contexts WHERE id = ?').run(removed)
  expect(takeStructuredWorkerDispatchEnds(db)).toEqual([
    'structured:worker-c',
    'structured:worker-d'
  ])
})
