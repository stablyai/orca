import { afterEach, beforeEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

function settledWorker(followUpOf?: string): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 100,
    taskId: task.id,
    followUpOf,
    startOptions: { agent: 'codex' }
  })
  db.db
    .prepare(
      "UPDATE dispatch_contexts SET status = 'completed', process_incarnation = 'proc_1' WHERE id = ?"
    )
    .run(dispatch.id)
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
    .run(dispatch.id)
  return dispatch.id
}

it('reads a terminal handed on along a chain once and shares it with every predecessor', () => {
  const predecessors = [settledWorker()]
  while (predecessors.length < 19) {
    predecessors.push(settledWorker(predecessors.at(-1)))
  }
  const owner = settledWorker(predecessors.at(-1))
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, terminal_handle,
          process_incarnation, ownership_state, release_state)
       VALUES ('res_1', ?, ?, ?, 'term_1', 'proc_1', 'owned', 'not_requested')`
    )
    .run(predecessors[0], owner, JSON.stringify(predecessors))

  const handedOn = db
    .listWorkerTerminalResources({ dispatchIds: predecessors })
    .map((row) => row.handedOn?.resource)

  expect(handedOn).toHaveLength(predecessors.length)
  expect(new Set(handedOn).size).toBe(1)
  expect(handedOn[0]).toMatchObject({ id: 'res_1', owner_dispatch_id: owner })
})
