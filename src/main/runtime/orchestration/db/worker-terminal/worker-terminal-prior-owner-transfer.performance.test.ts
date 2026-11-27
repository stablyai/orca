import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  readAgentSenderDirtyKeys,
  readAgentSenderGeneration
} from '../../../agent-senders/runtime-agent-sender-history-triggers'
import { AgentSenderWorkerHistory } from '../../../agent-senders/runtime-agent-sender-worker-history'
import '../attempt-outcome-projection'
import '../contract-constants'
import '../dispatch-row-writer'
import '../messages/mailbox-routing-page'
import { OrchestrationDb } from '../orchestration-db'

const PANE_KEY = 'tab_sender:11111111-1111-4111-8111-111111111111'
const HANDLE = 'term_sender'
const INCARNATION = 'pty:sender'
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })
const TOKEN_HASH = createHash('sha256').update('sender-launch').digest('hex')

const dbs: OrchestrationDb[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
  vi.useRealTimers()
})

function openDb(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  return db
}

// Incident: reopening a retained worker transferred custody by re-inserting all H+1 prior-owner
// index entries, marking 2H+1 historical sender keys, and traversing 3H+2 reverse owner edges (#47914).
it('inserts only the outgoing owner on append and reconciles non-append writes', () => {
  const db = openDb()
  const run = db.createRun({
    objective: 'custody',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const start = () =>
    db.createStartingWorkerDispatch({
      taskSpec: 'work',
      taskRunId: run.id,
      creator: { kind: 'system' },
      maxDepth: 3,
      startOptions: { agent: 'claude' }
    }).dispatch

  const owner = start()
  db.prepareStartingWorkerAuthority({
    dispatchId: owner.id,
    handle: HANDLE,
    paneKey: PANE_KEY,
    processIncarnation: INCARNATION,
    hostScope: HOST_SCOPE,
    worktreeId: 'wt_1',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  db.failWorkerStart(owner.id, 'dispatch_input', 'settled')
  const resource = db.getWorkerTerminalResourceByOwner(owner.id)
  if (!resource) {
    throw new Error('Expected owned resource')
  }
  const priors = Array.from(
    { length: 1_000 },
    (_, index) => `ctx_${index.toString(16).padStart(12, '0')}`
  )
  db.db
    .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
    .run(JSON.stringify(priors), resource.id)
  db.db
    .prepare(
      'DELETE FROM worker_terminal_resource_prior_owners WHERE dispatch_id = ? AND resource_id = ?'
    )
    .run(priors[0], resource.id)

  const successor = start()
  db.transferWorkerTerminalResourceStatement({
    resourceId: resource.id,
    toDispatchId: successor.id,
    terminalHandle: HANDLE,
    paneKey: PANE_KEY,
    processIncarnation: INCARNATION,
    hostScope: HOST_SCOPE
  })
  expect(db.getWorkerTerminalResourceFormerlyOwnedBy(owner.id)?.id).toBe(resource.id)
  // Full-array trigger re-insertion would restore the deleted historical index row on append.
  expect(db.getWorkerTerminalResourceFormerlyOwnedBy(priors[0] ?? '')).toBeUndefined()

  db.db
    .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
    .run(JSON.stringify([priors[0], owner.id]), resource.id)
  expect(db.getWorkerTerminalResourceFormerlyOwnedBy(priors[0] ?? '')?.id).toBe(resource.id)
  expect(db.getWorkerTerminalResourceFormerlyOwnedBy(priors[1] ?? '')).toBeUndefined()
})

it('retains candidate-parent sender facts across warm custody transfers at 100 and 1,000 owners', () => {
  for (const count of [100, 1_000]) {
    const db = openDb()
    const run = db.createRun({
      objective: 'senders',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const pane = {
      handle: HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: HOST_SCOPE,
      launchTokenHash: TOKEN_HASH,
      worktreeId: 'wt_1'
    }
    const createSettled = () => {
      const dispatch = db.createStartingWorkerDispatch({
        taskSpec: 'work',
        taskRunId: run.id,
        creator: { kind: 'system' },
        maxDepth: 3,
        startOptions: { agent: 'claude' }
      }).dispatch
      db.db
        .prepare(
          `UPDATE dispatch_contexts
              SET status = 'completed', assignee_handle = ?, assignee_pane_key = ?,
                  process_incarnation = ?, host_scope = ?, launch_token_hash = ?
            WHERE id = ?`
        )
        .run(HANDLE, PANE_KEY, INCARNATION, HOST_SCOPE, TOKEN_HASH, dispatch.id)
      return dispatch.id
    }
    const priors = Array.from({ length: count }, () => createSettled())
    const owner = createSettled()
    const resource = db.createWorkerTerminalResourceStatement({
      dispatchId: owner,
      worktreeId: 'wt_1',
      terminalHandle: HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: HOST_SCOPE,
      ownership: 'owned'
    })
    db.db
      .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
      .run(JSON.stringify(priors), resource.id)

    readAgentSenderGeneration(db, true)
    const history = new AgentSenderWorkerHistory()
    const distinctIdentities = (rows: { identity: string }[]) =>
      new Set(rows.map((row) => row.identity)).size
    const cold = { paneReads: 0, lineageReads: 0, lineageVisits: 0 }
    expect(distinctIdentities(history.read(db, [pane], cold).workers)).toBe(count + 2)
    expect(cold).toEqual({
      paneReads: 3,
      lineageReads: (count + 1) * 2,
      lineageVisits: count + 1
    })

    const nextOwner = createSettled()
    db.db.prepare('DELETE FROM temp.agent_sender_dirty').run()
    db.transferWorkerTerminalResourceStatement({
      resourceId: resource.id,
      toDispatchId: nextOwner,
      terminalHandle: HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: HOST_SCOPE
    })
    expect([...readAgentSenderDirtyKeys(db)].sort()).toEqual([`d:${owner}`, `p:${PANE_KEY}`])

    const warm = { paneReads: 0, lineageReads: 0, lineageVisits: 0 }
    expect(distinctIdentities(history.read(db, [pane], warm).workers)).toBe(count + 3)
    expect(warm).toEqual({
      paneReads: 3,
      lineageReads: 4,
      lineageVisits: count + 3
    })
  }
})
