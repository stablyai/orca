import { createHash } from 'node:crypto'

import { afterEach, expect, it } from 'vitest'

import { createRuntimeAgentProjections } from '../construction/runtime-agent-projections'

import { OrchestrationDb } from '../orchestration/db/orchestration-db'

import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

import { MIRROR_LEAVES_STEP_1 } from '../terminal/records/runtime-leaf-record-projection.test-fixture'

import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../terminal/records/runtime-terminal-state-records'

import './runtime-agent-sender-worker-history'
import './runtime-agent-sender-lineage'
import './runtime-agent-sender-history-triggers'
import '../orchestration/db/dispatch-context/worker-follow-up-plan'
import '../orchestration/db/dispatch-context/worker-follow-up-lineage'

const unissued = (): never => {
  throw new Error('a sender build issued a terminal handle')
}

const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

const pane = (i: number) =>
  `tab-${i}:${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
const handle = (i: number) => `term_tab-${i}`
const token = (i: number) => `launch-${i}`
const hash = (i: number) => createHash('sha256').update(token(i)).digest('hex')

/** A real database with `workers` independent live workers, each holding its own terminal. */
function host(workers: number, path: string = ':memory:') {
  const db = new OrchestrationDb(path)
  dbs.push(db)
  const run = db.createRun({
    objective: 'senders',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const leaves: RuntimeLeafRecord[] = []
  const ptys: RuntimePtyWorktreeRecord[] = []
  const hold = db.db.prepare(`INSERT INTO worker_terminal_resources
    (id, origin_dispatch_id, owner_dispatch_id, pane_key, terminal_handle, process_incarnation)
    VALUES (?, ?, ?, ?, ?, ?)`)
  const dispatch = (i: number, spec: string) => {
    const row = createRootDispatch(
      db,
      db.createTask({ runId: run.id, spec }).id,
      handle(i),
      pane(i)
    )
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET process_incarnation = ?, launch_token_hash = ? WHERE id = ?'
      )
      .run(`pty-${i}:inc-1`, hash(i), row.id)
    return row
  }
  const ids: string[] = []
  for (let i = 0; i < workers; i++) {
    leaves.push({
      ...MIRROR_LEAVES_STEP_1[0],
      tabId: `tab-${i}`,
      worktreeId: 'w',
      ptyId: `pty-${i}`
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only these fields.
    ptys.push({
      ptyId: `pty-${i}`,
      incarnationId: 'inc-1',
      launchIncarnationId: 'inc-1',
      launchToken: token(i),
      worktreeId: 'w'
    } as RuntimePtyWorktreeRecord)
    const id = dispatch(i, `worker ${i}`).id
    ids.push(id)
    hold.run(`res-${id}`, id, id, pane(i), handle(i), `pty-${i}:inc-1`)
  }
  // Assigned to a pane that isn't live here.
  const unrelated = dispatch(workers + 1, 'elsewhere')
  const start = (database: OrchestrationDb) =>
    createRuntimeAgentProjections(
      {
        getExistingOrchestrationDb: () => database,
        resolveOrchestrationWorkerServer: () => {
          throw new Error('unpaired')
        }
      },
      {
        getDb: () => database,
        getLeaves: () => leaves,
        getPtys: () => ptys,
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        // Orchestration issues handles; sender rows only read the ones already issued.
        issueLeafHandle: unissued,
        issuePtyHandle: unissued,
        readLeafHandle: (leaf) => `term_${leaf.tabId}`,
        readPtyHandles: () => () => null,
        makePaneKey: (leaf) => pane(Number(leaf.tabId.slice(4))),
        getWorktreeId: () => null,
        getHandleForPaneKey: () => null,
        getPaneKey: () => null,
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getSessionRecords: () => null
      }
    ).senders
  const senders = start(db)
  const rows = (publication: ReturnType<typeof senders.build>) =>
    publication.associations.map((row) => `${row.identity}@${row.paneKey}`).sort()
  return {
    db,
    leaves,
    ptys,
    hold,
    ids,
    unrelated,
    dispatch,
    senders,
    rows,
    /** What a cold build on its own connection publishes: the full rebuild to equal. */
    cold: (database = db) => rows(start(database).build())
  }
}

it('keeps nothing it read inside a transaction that rolls back', () => {
  const h = host(3)
  h.senders.build()
  const held = `dispatch:${h.ids[1]}@${pane(1)}`
  h.db.db.exec('BEGIN')
  h.db.db
    .prepare("UPDATE worker_terminal_resources SET ownership_state = 'released' WHERE id = ?")
    .run(`res-${h.ids[1]}`)
  h.senders.build()
  h.db.db.exec('ROLLBACK')
  expect(h.rows(h.senders.build())).toContain(held)
  // A later write no worker read leaves it as the database has it.
  h.db.db
    .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
    .run(h.unrelated.id)
  expect(h.rows(h.senders.build())).toEqual(h.cold())
})

it('proves the addressed invocation, withdraws on token-only retirement, and never follows a successor', () => {
  const h = host(2)
  const source = h.ids[0]
  const read = () =>
    h.senders.build().associations.find((row) => row.identity === `dispatch:${source}`)
  expect(read()).toMatchObject({ paneKey: pane(0), dispatchActor: true })
  // A different execution taking custody cannot move the still-running source actor.
  h.db.db.prepare('DELETE FROM worker_terminal_resources WHERE owner_dispatch_id = ?').run(source)
  h.db.db
    .prepare(
      'UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE owner_dispatch_id = ?'
    )
    .run(JSON.stringify([source]), h.ids[1])
  expect(read()).toMatchObject({ paneKey: pane(0), dispatchActor: true })
  h.ptys[0].launchToken = null
  h.ptys[0].launchIncarnationId = null
  expect(read()).toBeUndefined()
  // The same shell can run a same-kind successor, but that is a different invocation.
  h.ptys[0].launchToken = 'successor'
  h.ptys[0].launchIncarnationId = 'inc-1'
  expect(read()).toBeUndefined()
  h.ptys[0].launchToken = token(0)
  expect(read()).toMatchObject({ dispatchActor: true })
  for (const scope of [
    JSON.stringify({ kind: 'ssh', targetId: 'remote' }),
    JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }),
    'bad'
  ]) {
    h.db.db.prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?').run(scope, source)
    expect(read()).toBeUndefined()
  }
  h.db.db
    .prepare(
      'UPDATE dispatch_contexts SET host_scope = NULL, launch_token_hash = NULL WHERE id = ?'
    )
    .run(source)
  expect(read()).toBeUndefined()
  h.db.db
    .prepare(
      'UPDATE dispatch_contexts SET launch_token_hash = ?, process_incarnation = NULL WHERE id = ?'
    )
    .run(hash(0), source)
  expect(read()).toBeUndefined()
})

it('does not turn failed pre-attachment custody recovery into launch proof', () => {
  const h = host(1)
  const runId = h.db.getDispatchContextById(h.ids[0])!.run_id
  h.db.failDispatch(h.ids[0], 'old work')
  h.db.db.prepare('DELETE FROM worker_terminal_resources').run()
  const start = () =>
    h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: runId,
      taskSpec: 'start',
      startOptions: { agent: 'codex' }
    }).dispatch.id
  const before = start()
  h.db.recordWorkerStage({
    dispatchId: before,
    stage: 'terminal_created',
    terminalHandle: handle(0)
  })
  h.hold.run('before', before, before, pane(0), handle(0), 'pty-0:inc-1')
  h.db.failWorkerStart(before, 'authority_attachment', 'failed before attachment')
  expect(h.db.getDispatchContextById(before)).toMatchObject({
    process_incarnation: 'pty-0:inc-1',
    launch_token_hash: null
  })
  expect(h.senders.build().associations.some((row) => row.identity === `dispatch:${before}`)).toBe(
    false
  )
  h.db.db.prepare('DELETE FROM worker_terminal_resources').run()
  const after = start()
  h.db.prepareStartingWorkerAuthority({
    dispatchId: after,
    handle: handle(0),
    paneKey: pane(0),
    processIncarnation: 'pty-0:inc-1',
    launchTokenHash: hash(0),
    worktreeId: 'w',
    effects: [],
    setupState: 'not_applicable'
  })
  h.hold.run('after', after, after, pane(0), handle(0), 'pty-0:inc-1')
  h.db.failWorkerStart(after, 'task_input', 'failed after attachment')
  expect(h.senders.build().associations).toContainEqual(
    expect.objectContaining({ identity: `dispatch:${after}`, dispatchActor: true })
  )
})
