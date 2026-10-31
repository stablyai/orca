import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { MIRROR_LEAVES_STEP_1 } from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { AgentSenderWorkerHistory } from './runtime-agent-sender-worker-history'

const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

const pane = (i: number) =>
  `tab-${i}:${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
const handle = (i: number) => `term_tab-${i}`

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
  const dispatch = (i: number, spec: string) =>
    createRootDispatch(db, db.createTask({ runId: run.id, spec }).id, handle(i), pane(i))
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
        issueLeafHandle: (leaf) => `term_${leaf.tabId}`,
        issuePtyHandle: () => '',
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

it.each([100, 1000])(
  'reads no worker history for a write no live worker read, and only the changed worker for one it did, at %i live workers',
  (workers) => {
    const h = host(workers)
    const first = h.senders.build()
    expect(first.associations.filter((row) => row.identity.startsWith('dispatch:'))).toHaveLength(
      workers
    )
    // History reads; the one live-terminal walk each build makes is counted by its own test.
    const work = () => {
      const { leafVisits: _leaves, ptyVisits: _ptys, ...reads } = h.senders.workForTest()
      return reads
    }
    const settled = work()
    h.db.db
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(h.unrelated.id)
    expect(h.senders.build()).toBe(first)
    expect(work()).toEqual({ ...settled, historyReads: settled.historyReads + 1 })

    // One live worker lets its terminal go: its pane and its own lineage only.
    h.db.db
      .prepare("UPDATE worker_terminal_resources SET ownership_state = 'released' WHERE id = ?")
      .run(`res-${h.ids[0]}`)
    const changed = h.senders.build()
    expect({
      paneReads: work().paneReads - settled.paneReads,
      lineageReads: work().lineageReads - settled.lineageReads
    }).toEqual({ paneReads: 3, lineageReads: 3 })
    expect(h.rows(changed)).not.toContain(`dispatch:${h.ids[0]}@${pane(0)}`)
    expect(h.rows(changed)).toEqual(h.cold())
  }
)

it('follows each write that changes a worker, as a cold rebuild reads it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sender-history-'))
  const h = host(3, join(directory, 'orchestration.db'))
  const step = (only = (_row: string) => true) => {
    const rows = h.rows(h.senders.build())
    expect(rows.filter(only)).toEqual(h.cold().filter(only))
    return rows
  }
  step()
  // A follow-up of a worker whose earlier lookup found none takes it to the follow-up's own
  // terminal in another pane; only that earlier miss, not any pane it read, says so.
  h.leaves.push({ ...MIRROR_LEAVES_STEP_1[0], tabId: 'tab-3', worktreeId: 'w', ptyId: 'pty-3' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only these fields.
  h.ptys.push({
    ptyId: 'pty-3',
    incarnationId: 'inc-1',
    worktreeId: 'w'
  } as RuntimePtyWorktreeRecord)
  step()
  const followUp = h.dispatch(3, 'follow-up')
  h.hold.run(`res-${followUp.id}`, followUp.id, followUp.id, pane(3), handle(3), 'pty-3:inc-1')
  step()
  h.db.db
    .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
    .run(h.ids[0], followUp.id)
  expect(step()).toContain(`dispatch:${h.ids[0]}@${pane(3)}`)
  // A terminal that moves to another pane takes its worker there.
  h.db.db
    .prepare(
      "UPDATE worker_terminal_resources SET pane_key = ?, process_incarnation = 'pty-2:inc-1' WHERE id = ?"
    )
    .run(pane(2), `res-${h.ids[1]}`)
  expect(step()).toContain(`dispatch:${h.ids[1]}@${pane(2)}`)
  // A respawned process under the same pane no longer holds its worker.
  // (A fresh publisher sees the new process as the handle's first, so only worker rows compare.)
  h.ptys[2].incarnationId = 'inc-2'
  const dispatches = (row: string) => row.startsWith('dispatch:')
  expect(step(dispatches)).not.toContain(`dispatch:${h.ids[2]}@${pane(2)}`)
  h.db.db.prepare('DELETE FROM worker_terminal_resources WHERE id = ?').run(`res-${h.ids[0]}`)
  step(dispatches)
  // A rolled-back write marks nothing.
  const settled = h.senders.workForTest()
  const before = h.senders.build()
  h.db.db.exec('BEGIN')
  h.db.db.prepare("UPDATE worker_terminal_resources SET ownership_state = 'released'").run()
  h.db.db.exec('ROLLBACK')
  expect(h.senders.build()).toBe(before)
  expect(h.senders.workForTest().paneReads).toBe(settled.paneReads)
  // Another connection's commit, which no trigger here sees, rebuilds from the database.
  const other = new OrchestrationDb(join(directory, 'orchestration.db'))
  dbs.push(other)
  other.db
    .prepare("UPDATE worker_terminal_resources SET ownership_state = 'released' WHERE id = ?")
    .run(`res-${h.ids[1]}`)
  expect(step(dispatches)).not.toContain(`dispatch:${h.ids[1]}@${pane(2)}`)
})

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

it('forgets the workers and the keys it read once their panes close', () => {
  const h = host(20)
  // Installs this connection's triggers.
  h.senders.build()
  const history = new AgentSenderWorkerHistory()
  const work = { lineageReads: 0, paneReads: 0 }
  const panes = h.ids.map((_, i) => ({
    paneKey: pane(i),
    worktreeId: 'w',
    handle: handle(i),
    processIncarnation: `pty-${i}:inc-1`
  }))
  history.read(h.db, panes, work)
  const open = history.sizeForTest()
  expect(open.entries).toBe(20)
  history.read(h.db, panes.slice(0, 10), work)
  expect(history.sizeForTest().entries).toBe(10)
  expect(history.sizeForTest().dependencies).toBeLessThan(open.dependencies)
  history.read(h.db, [], work)
  expect(history.sizeForTest()).toEqual({ entries: 0, dependencies: 0 })
})
