import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { buildWorkerAttentionContext } from './worker-attention-context'
import { readWorkerDock, readWorkerDockResult } from '../../dock/worker-dock-read'
import { projectWorkerFleet } from '../../../rpc/methods/orchestration/worker/fleet/worker-list-projection'

const SESSION = '11111111-1111-4111-8111-111111111111'
const PARTY = `orca_session_id:${SESSION}`
const NOW = Date.parse('2026-11-25T12:00:00Z')

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
})

function startedWorker(): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Verify journal writes' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
    .run(SESSION, dispatch.id)
  return dispatch.id
}

function readyWorker(): string {
  const dispatchId = startedWorker()
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
    .run(dispatchId)
  return dispatchId
}

/** What the dock and worker-show each say about one worker. */
function readings(dispatchId: string) {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  const shown = projectWorkerFleet({
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], NOW),
    statuses: [],
    limit: 1,
    now: NOW
  }).workers[0]
  return {
    dockRow: readWorkerDock(db, { party: PARTY, direction: 'around' }).rows.find(
      (row) => row.dispatchId === dispatchId
    )?.state,
    dockCard: readWorkerDockResult(db, PARTY, dispatchId)?.outcome,
    show: shown.outcome,
    attention: attention(dispatchId)
  }
}

function attention(dispatchId: string) {
  const dispatch = db.getDispatchContextById(dispatchId)!
  return buildWorkerAttentionContext({
    db,
    dispatch,
    task: db.getTask(dispatch.task_id),
    evidence: undefined
  }).categories
}

describe('worker attention outcome', () => {
  it('reads a coordinator worker-stop as stopped in the dock and worker-show alike', () => {
    const dispatchId = readyWorker()
    db.beginWorkerStop(dispatchId, 'epoch_1')
    db.settleWorkerStop(dispatchId)

    // The row shape every earlier stop already wrote, so old rows read the same way.
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped'
    })
    expect(readings(dispatchId)).toEqual({
      dockRow: undefined,
      dockCard: 'stopped',
      show: 'stopped',
      attention: []
    })
  })

  it('reads an unexplained exit as unexpected in the dock and a failure in worker-show', () => {
    const dispatchId = readyWorker()
    db.reconcileMissingWorkerTerminal(dispatchId, 'The worker terminal is gone.')

    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
    const read = readings(dispatchId)
    expect(read).toMatchObject({ dockRow: 'unexpected', dockCard: 'unexpected', show: 'failed' })
    expect(read.attention).toContain('failure')
  })

  it('still reads a failed start as a failure', () => {
    const dispatchId = startedWorker()
    db.failWorkerStart(dispatchId, 'verification', 'Verification exited with code 1.')

    expect(attention(dispatchId)).toContain('failure')
  })
})
