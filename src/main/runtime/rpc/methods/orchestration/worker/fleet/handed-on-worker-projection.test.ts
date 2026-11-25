import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { projectWorkerFleet } from './worker-list-projection'
import { exposeWorkerTerminalResource } from '../release/worker-terminal-resource-presentation'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

function settledWorker(followUpOf?: string): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
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

/** A predecessor whose one terminal row its follow-up took over, as the transfer writes it. */
function handedOnPair(releaseState: string) {
  const predecessor = settledWorker()
  const followUp = settledWorker(predecessor)
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, terminal_handle,
          process_incarnation, ownership_state, release_state)
       VALUES ('res_1', ?, ?, ?, 'term_1', 'proc_1', 'owned', ?)`
    )
    .run(predecessor, followUp, JSON.stringify([predecessor]), releaseState)
  return { predecessor, followUp }
}

function project(dispatchId: string) {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  return projectWorkerFleet({
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], Date.now()),
    statuses: [],
    limit: 1,
    now: Date.now()
  }).workers[0]
}

describe('a settled worker whose terminal went to its follow-up', () => {
  it('reads as handed on to that follow-up, needing no action', () => {
    const { predecessor, followUp } = handedOnPair('not_requested')
    const worker = project(predecessor)
    expect(worker.liveness).toEqual({ verdict: 'unverifiable', reason: 'handed_on' })
    expect(worker.resource).toMatchObject({
      state: 'transferred',
      id: 'res_1',
      ownerDispatchId: followUp
    })
    expect(worker.attention.requiresAction).toBe(false)
    expect(worker.nextAction.kind).toBe('none')
  })

  it('reads as exited once the follow-up released the shared terminal', () => {
    const { predecessor } = handedOnPair('released')
    const worker = project(predecessor)
    expect(worker.liveness).toEqual({ verdict: 'exited', source: 'resource_release' })
    expect(worker.attention.requiresAction).toBe(false)
  })

  it('exposes the ordered earlier owners on the shared terminal', () => {
    const { predecessor } = handedOnPair('not_requested')
    const resource = db.getWorkerTerminalResourceFormerlyOwnedBy(predecessor)!
    expect(exposeWorkerTerminalResource(resource).priorOwnerDispatchIds).toEqual([predecessor])
  })
})
