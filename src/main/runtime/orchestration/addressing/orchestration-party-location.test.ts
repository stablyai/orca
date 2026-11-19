import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import { locateOrchestrationParty } from './orchestration-party-location'

let db: OrchestrationDb | null = null
afterEach(() => {
  db?.close()
  db = null
})

function dispatchWithNoAssignee(): { db: OrchestrationDb; dispatchId: string } {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'Triage',
    coordinatorHandle: 'term-coordinator',
    coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ spec: 'Investigate on the Windows box', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_unused')
  // A worker started on a paired server leaves this machine's assignee empty.
  db.db
    .prepare(
      'UPDATE dispatch_contexts SET assignee_handle = NULL, assignee_pane_key = NULL WHERE id = ?'
    )
    .run(dispatch.id)
  return { db, dispatchId: dispatch.id }
}

function locate(database: OrchestrationDb, dispatchId: string) {
  return locateOrchestrationParty(`dispatch:${dispatchId}`, {
    db: database,
    records: null,
    terminalPaneKey: () => null,
    terminalHandleForPaneKey: () => null
  })
}

describe('locating a Dispatch', () => {
  it("finds a paired server's worker by the terminal that server issued", () => {
    const { db: database, dispatchId } = dispatchWithNoAssignee()
    database.db
      .prepare(
        `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version, remote_terminal_handle)
         VALUES (?, 'env-win', 'windows 2', 'peer-win', 3, 'term_remote')`
      )
      .run(dispatchId)

    expect(locate(database, dispatchId)).toEqual({
      location: { kind: 'terminal', handle: 'term_remote', environmentId: 'env-win' }
    })
  })

  it('finds nothing, without claiming it gone, when no host recorded a terminal', () => {
    const { db: database, dispatchId } = dispatchWithNoAssignee()
    expect(locate(database, dispatchId)).toEqual({ location: null })
  })
})
