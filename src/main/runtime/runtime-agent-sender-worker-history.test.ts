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
import { AgentSenderLineageGraph } from './runtime-agent-sender-lineage'
import { readAgentSenderGeneration } from './runtime-agent-sender-history-triggers'
import { resolveWorkerLineageFacts } from './orchestration/db/dispatch-context/worker-follow-up-plan'
import { getFollowUpDispatch } from './orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { AgentSenderPane } from './runtime-agent-sender-history'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import type { DispatchContextRow } from './orchestration/types'

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
  h.ptys[2] = { ...h.ptys[2], incarnationId: 'inc-2' }
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

const livePane = (i: number): AgentSenderPane => ({
  paneKey: pane(i),
  worktreeId: 'w',
  handle: handle(i),
  processIncarnation: `pty-${i}:inc-1`
})

/** Snapshot only the fixture's known keys; the oracle still executes the uncached production walk. */
function oracle(db: OrchestrationDb, ids: string[]) {
  const rows = new Map(ids.map((id) => [id, db.getDispatchContextById(id)]))
  const resources = new Map(ids.map((id) => [id, db.getWorkerTerminalResourceByOwner(id)]))
  const followUps = new Map(
    [...rows.values()].flatMap((row) =>
      row?.follow_up_of_dispatch_id ? [[row.follow_up_of_dispatch_id, row] as const] : []
    )
  )
  const facts = {
    dispatch: (id: string) => rows.get(id),
    ownedResource: (id: string) => resources.get(id),
    formerResource: () => undefined,
    followUp: (id: string) => followUps.get(id)
  }
  return ids.flatMap((id) => {
    const resolved = resolveWorkerLineageFacts(facts, id)
    const row = rows.get(id)
    return resolved?.resource && !resolved.latest.assignee_orca_session_id
      ? [
          { identity: `dispatch:${id}`, paneKey: resolved.resource.pane_key },
          ...(row?.assignee_handle
            ? [{ identity: row.assignee_handle, paneKey: resolved.resource.pane_key }]
            : [])
        ]
      : []
  })
}

it.each([100, 1000])(
  'shares traversal and every retained membership for a %i-deep chain, preserving all oracle aliases',
  (depth) => {
    const h = host(depth)
    const tail = h.ids[depth - 1]
    h.db.db.exec('BEGIN')
    {
      h.db.db
        .prepare('DELETE FROM worker_terminal_resources WHERE owner_dispatch_id != ?')
        .run(tail)
      h.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id != ?").run(tail)
      const link = h.db.db.prepare(
        'UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?'
      )
      for (let i = 1; i < depth; i++) {
        link.run(h.ids[i - 1], h.ids[i])
      }
    }
    h.db.db.exec('COMMIT')
    readAgentSenderGeneration(h.db, true)
    const history = new AgentSenderWorkerHistory()
    const work = { lineageReads: 0, paneReads: 0, lineageVisits: 0 }
    const panes = [livePane(depth - 1)]
    const sort = (rows: { identity: string; paneKey: string | null }[]) =>
      rows.map((row) => `${row.identity}@${row.paneKey}`).sort()
    const check = () => {
      const before = work.lineageVisits
      const result = history.read(h.db, panes, work)
      expect(sort(result.workers)).toEqual(sort(oracle(h.db, h.ids)))
      expect(result.workers).toHaveLength(depth * 2)
      const size = history.graphSizeForTest()
      expect(size).toEqual({
        nodes: depth,
        edges: 2 * (depth - 1),
        reverseMemberships: 2 * (depth - 1)
      })
      expect(work.lineageVisits - before).toBeLessThanOrEqual(depth * 14)
      const tracked = h.db.db.prepare('SELECT count(*) AS n FROM temp.agent_sender_tracked').get()
      expect(tracked).toEqual({ n: depth + 1 })
      // Fact slots, summary pointers, both edge directions, tracking, aliases and the live root.
      const memberships =
        4 * size.nodes +
        size.edges +
        size.reverseMemberships +
        depth +
        1 +
        result.workers.length +
        1
      expect(memberships).toBeLessThanOrEqual(depth * 12)
      console.info(
        JSON.stringify({ depth, visits: work.lineageVisits - before, memberships, ...size })
      )
    }
    check()
    expect(work.lineageReads).toBe(depth * 3)
    // An interior identity change invalidates the reverse closure without rereading that closure.
    h.db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_changed-interior', h.ids[Math.floor(depth / 2)])
    const reads = work.lineageReads
    check()
    expect(work.lineageReads - reads).toBe(6)
    // Extend the cached negative follow-up slot, preserving the carried resource fallback.
    const next = h.dispatch(depth, 'tail extension')
    h.db.db
      .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
      .run(tail, next.id)
    const result = history.read(h.db, panes, work)
    expect(sort(result.workers)).toEqual(sort(oracle(h.db, h.ids)))
    expect(result.workers).toHaveLength(depth * 2)
    expect(history.graphSizeForTest().nodes).toBe(depth + 1)
    history.read(h.db, [], work)
    expect(history.graphSizeForTest()).toEqual({ nodes: 0, edges: 0, reverseMemberships: 0 })
  }
)

it('preserves addressed-root cycle, missing-record, nearest-resource and transfer precedence semantics', () => {
  const h = host(1)
  const template = h.db.getDispatchContextById(h.ids[0])!
  const resource = h.db.getWorkerTerminalResourceByOwner(h.ids[0])!
  const row = (id: string, parent: string | null = null): DispatchContextRow => ({
    ...template,
    id,
    follow_up_of_dispatch_id: parent
  })
  const held = (owner: string): WorkerTerminalResourceRow => ({
    ...resource,
    owner_dispatch_id: owner,
    origin_dispatch_id: owner
  })
  const cases = [
    { rows: [row('a', 'b'), row('b', 'a')], owned: [], former: [] },
    { rows: [row('a', 'b'), row('b', 'a')], owned: [['b', held('b')]], former: [] },
    { rows: [row('a'), row('b', 'a'), row('c', 'b')], owned: [['a', held('a')]], former: [] },
    {
      rows: [row('a'), row('b', 'a'), row('c')],
      owned: [['c', held('c')]],
      former: [['a', held('c')]]
    },
    { rows: [row('a'), row('b', 'a'), row('c', 'b')], owned: [], former: [['b', held('a')]] },
    { rows: [row('a', 'missing'), row('b', 'a')], owned: [], former: [['a', held('missing')]] },
    { rows: [row('a'), row('b', 'a'), row('c', 'a')], owned: [['a', held('a')]], former: [] }
  ] satisfies {
    rows: DispatchContextRow[]
    owned: [string, WorkerTerminalResourceRow][]
    former: [string, WorkerTerminalResourceRow][]
  }[]
  for (const scenario of cases) {
    const rows = new Map(scenario.rows.map((value) => [value.id, value]))
    const owned = new Map(scenario.owned)
    const former = new Map(scenario.former)
    const facts = {
      dispatch: (id: string) => rows.get(id),
      ownedResource: (id: string) => owned.get(id),
      formerResource: (id: string) => former.get(id),
      followUp: (id: string) => scenario.rows.find((value) => value.follow_up_of_dispatch_id === id)
    }
    const graph = new AgentSenderLineageGraph()
    graph.retain(rows.keys(), facts, () => {})
    for (const id of rows.keys()) {
      expect(graph.resolve(id)).toEqual(resolveWorkerLineageFacts(facts, id))
    }
    if (owned.size === 0 && former.size === 0 && rows.has('b')) {
      expect(graph.resolve('a')?.latest.id).toBe('a')
      expect(graph.resolve('b')?.latest.id).toBe('b')
    }
    graph.retain([], facts, () => {})
    expect(graph.sizeForTest()).toEqual({ nodes: 0, edges: 0, reverseMemberships: 0 })
  }
})

it.each([100, 1000])(
  'tracks only current direct facts and reconstructs truth after %i dormant writes',
  (writes) => {
    const h = host(2)
    readAgentSenderGeneration(h.db, true)
    const history = new AgentSenderWorkerHistory()
    const work = { lineageReads: 0, paneReads: 0 }
    const panes = [livePane(0)]
    history.read(h.db, panes, work)
    const count = (table: 'agent_sender_dirty' | 'agent_sender_tracked') =>
      h.db.db.prepare(`SELECT count(*) AS n FROM temp.${table}`).get()
    h.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id != ?").run(h.ids[0])
    expect(count('agent_sender_dirty')).toEqual({ n: 0 })
    history.release(h.db)
    expect(count('agent_sender_tracked')).toEqual({ n: 0 })
    for (let i = 0; i < writes; i++) {
      h.dispatch(i + 3, 'unowned history')
    }
    const next = h.dispatch(2, 'dormant follow-up')
    h.db.db
      .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
      .run(h.ids[0], next.id)
    h.db.db.prepare("UPDATE worker_terminal_resources SET ownership_state = 'released'").run()
    expect(count('agent_sender_dirty')).toEqual({ n: 0 })
    expect(history.read(h.db, panes, work).workers).toEqual([])
    expect(history.graphSizeForTest().nodes).toBe(2)
    h.db.db
      .prepare("UPDATE worker_terminal_resources SET ownership_state = 'owned' WHERE id = ?")
      .run(`res-${h.ids[0]}`)
    expect(history.read(h.db, panes, work).workers).toEqual(oracle(h.db, [h.ids[0]]))
  }
)

it('replaces and retires former-owner dependencies when a terminal resource transfers', () => {
  const h = host(3)
  h.senders.build()
  h.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(h.ids[0])
  h.db.db.prepare('DELETE FROM worker_terminal_resources WHERE id = ?').run(`res-${h.ids[0]}`)
  const transfer = h.db.db.prepare(
    'UPDATE worker_terminal_resources SET origin_dispatch_id = ?, prior_owner_dispatch_ids = ? WHERE id = ?'
  )
  transfer.run(h.ids[0], JSON.stringify([h.ids[0]]), `res-${h.ids[1]}`)
  const moved = h.rows(h.senders.build())
  expect(moved).toContain(`dispatch:${h.ids[0]}@${pane(1)}`)
  expect(moved).toEqual(h.cold())
  transfer.run(h.ids[1], '[]', `res-${h.ids[1]}`)
  const retired = h.rows(h.senders.build())
  expect(retired.some((value) => value.startsWith(`dispatch:${h.ids[0]}@`))).toBe(false)
  expect(retired).toEqual(h.cold())
})

it('keeps a structured self-cycle separate from another root sharing a missing resource owner', () => {
  const h = host(1)
  const a = h.ids[0]
  h.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(a)
  const c = h.dispatch(1, 'structured self-cycle').id
  const missing = 'missing-transferred-owner'
  h.db.db
    .prepare(
      "UPDATE dispatch_contexts SET status = 'completed', follow_up_of_dispatch_id = id, assignee_orca_session_id = ? WHERE id = ?"
    )
    .run('structured-c', c)
  h.db.db
    .prepare(
      'UPDATE worker_terminal_resources SET owner_dispatch_id = ?, prior_owner_dispatch_ids = ? WHERE id = ?'
    )
    .run(missing, JSON.stringify([a, c]), `res-${a}`)
  const resource = h.db.getWorkerTerminalResourceByOwner(missing)
  expect(resource?.origin_dispatch_id).toBe(a)
  expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy(a)).toEqual(resource)
  expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy(c)).toEqual(resource)
  expect(h.db.getDispatchContextById(missing)).toBeUndefined()
  const facts = {
    dispatch: (id: string) => h.db.getDispatchContextById(id),
    ownedResource: (id: string) => h.db.getWorkerTerminalResourceByOwner(id),
    formerResource: (id: string) => h.db.getWorkerTerminalResourceFormerlyOwnedBy(id),
    followUp: (id: string) => getFollowUpDispatch(h.db, id)
  }
  const graph = new AgentSenderLineageGraph()
  graph.retain([a, c, missing], facts, () => {})
  for (const id of [a, c, missing]) {
    expect(graph.resolve(id)).toEqual(resolveWorkerLineageFacts(facts, id))
  }
  expect(graph.resolve(c)?.latest.id).toBe(c)
  readAgentSenderGeneration(h.db, true)
  const history = new AgentSenderWorkerHistory()
  const work = { lineageReads: 0, paneReads: 0 }
  const read = () => history.read(h.db, [livePane(0)], work).workers
  expect(read()).toEqual([
    { identity: `dispatch:${a}`, paneKey: pane(0) },
    { identity: handle(0), paneKey: pane(0) }
  ])
  h.db.db
    .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = NULL WHERE id = ?')
    .run(c)
  expect(read()).toContainEqual({ identity: `dispatch:${c}`, paneKey: pane(0) })
  h.db.db
    .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
    .run('structured-c', c)
  expect(read().some((row) => row.identity === `dispatch:${c}` || row.identity === handle(1))).toBe(
    false
  )
})
