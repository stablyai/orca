// #50060 — a worker that reused an external terminal stayed "retained" after that terminal
// ended. A release-state invariant whose silent regression strands workers in the fleet
// projection, so one test for the statement and its fences.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { deriveWorkerTerminalListState } from '../../terminal-authority/release/worker-terminal-ownership'
import { projectLiveness } from '../../../../../shared/orchestration/fleet/orchestration-fleet-worker-projection'

const endedProcess = 'pty-7:incarnation-of-the-ended-process'
const successorProcess = 'pty-8:incarnation-of-its-successor'
const ROW_IDS = ['res_reporter', 'res_retained', 'res_successor', 'res_owned', 'res_chat']

let db: OrchestrationDb
let runId: string
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  runId = db.createRun({
    objective: 'external terminal exit test Run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab:coord'
  }).id
})
afterEach(() => db.close())

function settledWorker(): string {
  const task = db.createTask({ runId, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 100,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(dispatch.id)
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
    .run(dispatch.id)
  return dispatch.id
}

/** A row naming a process; the defaults are what `worker-start --terminal` mints. */
function resource(
  id: string,
  processIncarnation: string,
  fields: {
    owner?: string
    ownership?: 'external' | 'owned'
    releaseState?: 'not_requested' | 'retained'
    handle?: string
  } = {}
): void {
  const owner = fields.owner ?? settledWorker()
  const ownership = fields.ownership ?? 'external'
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation,
          ownership_state, release_state, retained_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      owner,
      owner,
      fields.handle ?? 'term_external',
      processIncarnation,
      ownership,
      fields.releaseState ?? 'not_requested',
      ownership === 'external' ? 'external_terminal' : null
    )
}

/** Each row's release_state and ownership_state, by id. */
function states(): Record<string, [string, string] | undefined> {
  return Object.fromEntries(
    ROW_IDS.map((id) => {
      const row = db.getWorkerTerminalResource(id)
      return [id, row && [row.release_state, row.ownership_state]]
    })
  )
}

it('releases exactly the external rows naming the ended process, and nothing else', () => {
  const owner = settledWorker()
  // The reporter's row, under a handle reminted since the worker's start.
  resource('res_reporter', endedProcess, { owner, handle: 'term_old_mint' })
  // The same ended process, under a retain.
  resource('res_retained', endedProcess, { releaseState: 'retained' })
  // What must survive: a successor in the same pane, a terminal Orca owns, and a chat whose
  // history reads through its unreleased row.
  resource('res_successor', successorProcess)
  resource('res_owned', endedProcess, { ownership: 'owned' })
  resource('res_chat', endedProcess, { handle: 'structworker_chat' })

  // Without the incarnation that proves which process ended, nothing is written.
  expect(db.settleExternallyEndedWorkerTerminals(null)).toBe(0)
  expect(db.getWorkerTerminalResource('res_reporter')?.release_state).toBe('not_requested')

  expect(db.settleExternallyEndedWorkerTerminals(endedProcess)).toBe(2)
  expect(states()).toEqual({
    res_reporter: ['released', 'released'],
    res_retained: ['released', 'released'],
    res_successor: ['not_requested', 'external'],
    res_owned: ['not_requested', 'owned'],
    res_chat: ['not_requested', 'external']
  })

  // The surfaces the reporter read follow the row.
  const released = db.getWorkerTerminalResource('res_reporter')
  expect(released?.release_completed_at).not.toBeNull()
  expect(
    deriveWorkerTerminalListState({
      workerState: 'succeeded',
      agentTerminalHandle: 'term_old_mint',
      resource: released ?? null
    })
  ).toBe('released')
  expect(
    projectLiveness(
      {
        workerState: 'succeeded',
        resource: { releaseState: released?.release_state, hostScope: null }
      },
      undefined,
      0
    )
  ).toEqual({ verdict: 'exited', source: 'resource_release' })
  expect(db.requestWorkerTerminalRelease(owner)).toMatchObject({ disposition: 'already_released' })
})
