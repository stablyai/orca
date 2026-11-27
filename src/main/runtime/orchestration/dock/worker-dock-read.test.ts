import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { acknowledgeWorkerDock, readWorkerDock, readWorkerDockResult } from './worker-dock-read'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import { subscribeWorkerDock } from './worker-dock-stream'
import { refreshWorkerDockActivity, workerDockActivitySource } from './worker-dock-activity'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { installWorkerDockSchema } from '../db/schema/worker-dock-schema'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const session = '11111111-1111-4111-8111-111111111111'
const party = `orca_session_id:${session}`
let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

function worker() {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Verify journal writes' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {
      agent: 'codex',
      model: 'requested-model',
      launch: { effective: { agent: 'codex', model: 'recorded-model', effort: null } }
    }
  })
  db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
    .run(session, dispatch.id)
  return dispatch.id
}
const read = () => readWorkerDock(db, { party, direction: 'around' })

function report(dispatchId: string, outcome: 'succeeded' | 'failed') {
  db.db
    .prepare(
      "UPDATE worker_dispatches SET state = ?, updated_at = '2026-11-14T12:00:00Z' WHERE dispatch_id = ?"
    )
    .run(outcome, dispatchId)
  db.db
    .prepare(`INSERT INTO messages(id, from_handle, to_handle, subject, body, type, payload)
    VALUES(?, 'term_worker', ?, 'Finished', 'Verified the journal.', 'worker_done', ?)`)
    .run(`msg_${dispatchId}`, party, JSON.stringify({ outcome }))
  db.recordAttemptObservation({
    id: `worker_report:msg_${dispatchId}`,
    dispatchId,
    sequence: 1,
    authorityId: 'run_home:run_legacy_local',
    authorityClock: 'home',
    facet: 'worker_report',
    payload: { status: 'accepted', outcome },
    homeReceivedAt: 1794657600000
  })
}

describe('worker dock lifecycle projection', () => {
  it('streams active workers ahead of a full page of older failures', async () => {
    for (let index = 0; index < 50; index++) {
      report(worker(), 'failed')
    }
    const active = worker()
    const emit = vi.fn<(snapshot: ReturnType<typeof readWorkerDock>) => void>()
    const unsubscribe = subscribeWorkerDock(db, party, emit, undefined, true, true)
    try {
      const snapshot = emit.mock.lastCall?.[0]
      expect(snapshot?.identities.map((row) => row.dispatchId)).toEqual([active])
      expect(snapshot?.rows.map((row) => row.dispatchId)).toEqual([active])
      expect(db.workerDockSources.read(session)?.open).toBe(true)

      report(active, 'succeeded')
      db.workerDockSources.invalidate(session)
      db.crewChanges.notify(new Set(['topology']))
      await Promise.resolve()

      expect(emit.mock.lastCall?.[0].identities).toEqual([])
      expect(emit.mock.lastCall?.[0]).not.toHaveProperty('results')
      expect(readWorkerDockResult(db, party, active)?.outcome).toBe('succeeded')
      expect(db.workerDockSources.read(session)?.open).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('preserves a normalized status episode through replay and retains unverifiable membership', () => {
    vi.useFakeTimers({ now: 1794657600000 })
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?").run(id)
    db.db
      .prepare(
        "UPDATE dispatch_contexts SET assignee_handle = 'term_episode', assignee_pane_key = 'pane_episode', process_incarnation = 'incarnation_episode' WHERE id = ?"
      )
      .run(id)
    let statuses: AgentStatusIpcPayload[] = [
      {
        paneKey: 'pane_episode',
        state: 'done',
        prompt: '',
        connectionId: null,
        receivedAt: 1794657600000,
        stateStartedAt: 100
      }
    ]
    const runtime: Parameters<typeof refreshWorkerDockActivity>[2] = {
      readAgentStatusOfPanes: () => statuses,
      readObservedAgentStatusPaneIdentityFn: () => ({
        kind: 'observed',
        dispatchId: id,
        terminalHandle: 'term_episode',
        processIncarnation: 'incarnation_episode'
      }),
      getAgentStatusTerminalHandleForPaneKey: () => 'term_episode',
      getTerminalProcessIncarnation: () => 'incarnation_episode'
    }
    refreshWorkerDockActivity(db, party, runtime)
    expect(read().rows[0].state).toBe('idle')
    const at = read().rows[0].changedAt
    statuses = [{ ...statuses[0], receivedAt: 1794657610000, isReplay: true }]
    refreshWorkerDockActivity(db, party, runtime)
    expect(read().rows[0].changedAt).toBe(at)
    statuses = []
    refreshWorkerDockActivity(db, party, runtime)
    expect(read().rows[0]).toMatchObject({ dispatchId: id, state: 'unavailable' })
  })

  it('keeps agent-status churn of a running worker out of the database', () => {
    vi.useFakeTimers({ now: 1794657600000 })
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?").run(id)
    db.db
      .prepare(
        "UPDATE dispatch_contexts SET assignee_handle = 'term_churn', assignee_pane_key = 'pane_churn', process_incarnation = 'incarnation_churn' WHERE id = ?"
      )
      .run(id)
    let status: AgentStatusIpcPayload = {
      paneKey: 'pane_churn',
      state: 'working',
      prompt: 'Fix the beachball',
      connectionId: null,
      receivedAt: 1794657600000,
      stateStartedAt: 100
    }
    const runtime: Parameters<typeof refreshWorkerDockActivity>[2] = {
      readAgentStatusOfPanes: () => [status],
      readObservedAgentStatusPaneIdentityFn: () => ({
        kind: 'observed',
        dispatchId: id,
        terminalHandle: 'term_churn',
        processIncarnation: 'incarnation_churn'
      }),
      getAgentStatusTerminalHandleForPaneKey: () => 'term_churn',
      getTerminalProcessIncarnation: () => 'incarnation_churn'
    }
    refreshWorkerDockActivity(db, party, runtime)
    const before = read()
    expect(before.rows[0]).toMatchObject({ dispatchId: id, state: 'running' })
    const changes = () => db.db.prepare('SELECT total_changes() AS n').get()?.n
    const changed = changes()
    const writes: string[] = []
    let refreshing = false
    const refresh = () => {
      refreshing = true
      try {
        refreshWorkerDockActivity(db, party, runtime)
      } finally {
        refreshing = false
      }
    }
    const prepare = db.db.prepare.bind(db.db)
    const exec = db.db.exec.bind(db.db)
    vi.spyOn(db.db, 'prepare').mockImplementation((sql: string) => {
      if (refreshing && !/^\s*SELECT\b/i.test(sql)) {
        writes.push(sql)
      }
      return prepare(sql)
    })
    vi.spyOn(db.db, 'exec').mockImplementation((sql: string) => {
      if (refreshing) {
        writes.push(sql)
      }
      return exec(sql)
    })
    // Heartbeats, prompt edits and replays of the same working episode change nothing visible.
    for (let tick = 1; tick <= 200; tick++) {
      vi.setSystemTime(1794657600000 + tick * 1000)
      status = { ...status, receivedAt: 1794657600000 + tick * 1000, prompt: `step ${tick}` }
      refresh()
    }
    expect(read()).toEqual(before)
    // A visible change, running to idle, still writes nothing: activity lives in memory.
    status = { ...status, state: 'done', stateStartedAt: 200 }
    refresh()
    const after = read()
    expect(after.rows[0]).toMatchObject({ dispatchId: id, state: 'idle' })
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(writes).toEqual([])
    expect(changes()).toBe(changed)
  })

  it('does no SELECT and no every-pane snapshot for a heartbeat that changes nothing shown', async () => {
    vi.useFakeTimers({ now: 1794657600000, toFake: ['Date'] })
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?").run(id)
    db.db
      .prepare(
        "UPDATE dispatch_contexts SET assignee_handle = 'term_beat', assignee_pane_key = 'pane_beat', process_incarnation = 'incarnation_beat' WHERE id = ?"
      )
      .run(id)
    let status: AgentStatusIpcPayload = {
      paneKey: 'pane_beat',
      state: 'working',
      prompt: 'Fix the beachball',
      connectionId: null,
      receivedAt: 1794657600000,
      stateStartedAt: 100
    }
    // The activity source cannot reach the every-pane snapshot: its runtime type has only per-pane reads.
    const counts = { onePane: 0, selects: 0, emits: 0 }
    let changed: ((pane: string) => void) | undefined
    const source = workerDockActivitySource(db, party, {
      readAgentStatusOfPanes: (panes) => {
        counts.onePane++
        return panes.includes(status.paneKey) ? [status] : []
      },
      readObservedAgentStatusPaneIdentityFn: () => ({
        kind: 'observed',
        dispatchId: id,
        terminalHandle: 'term_beat',
        processIncarnation: 'incarnation_beat'
      }),
      getAgentStatusTerminalHandleForPaneKey: () => 'term_beat',
      getTerminalProcessIncarnation: () => 'incarnation_beat',
      subscribeAgentStatusRowChanges: (listener) => {
        changed = listener
        return () => {}
      }
    })
    const snapshots: string[] = []
    const stop = subscribeWorkerDock(
      db,
      party,
      (value) => {
        counts.emits++
        snapshots.push(value.rows[0]?.state ?? '')
      },
      source
    )
    expect(snapshots).toEqual(['running'])
    const prepare = db.db.prepare.bind(db.db)
    vi.spyOn(db.db, 'prepare').mockImplementation((sql: string) => {
      counts.selects++
      return prepare(sql)
    })
    Object.assign(counts, { onePane: 0, selects: 0, emits: 0 })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    for (let tick = 1; tick <= 50; tick++) {
      vi.setSystemTime(1794657600000 + tick * 1000)
      status = { ...status, receivedAt: 1794657600000 + tick * 1000, prompt: `step ${tick}` }
      changed!('pane_beat')
      changed!('pane_unrelated')
      await settle()
    }
    // One pane read per own heartbeat; unrelated panes cost a Set lookup.
    expect(counts).toEqual({ onePane: 50, selects: 0, emits: 0 })
    status = { ...status, state: 'done', stateStartedAt: 200 }
    changed!('pane_beat')
    await settle()
    expect(snapshots.at(-1)).toBe('idle')
    stop()
  })

  it('keeps a delayed compact body visible as saving until the durable message arrives', () => {
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?").run(id)
    db.recordAttemptObservation({
      id: 'worker_report:msg_delayed',
      dispatchId: id,
      sequence: 1,
      authorityId: 'run_home:run_legacy_local',
      authorityClock: 'home',
      facet: 'worker_report',
      payload: { status: 'accepted', outcome: 'succeeded' },
      homeReceivedAt: 1794657600000
    })
    expect(read().rows[0].state).toBe('saving')
    db.insertMessage({
      id: 'msg_delayed',
      from: 'term_worker',
      to: party,
      type: 'worker_done',
      subject: 'Finished',
      body: 'The journal is verified.',
      payload: JSON.stringify({ outcome: 'succeeded' })
    })
    expect(read().identities).toEqual([])
    expect(readWorkerDockResult(db, party, id)?.body).toBe('The journal is verified.')
  })

  it('marks a failed report as the worker report and a start failure as a raw error', () => {
    const reported = worker()
    report(reported, 'failed')
    expect(readWorkerDockResult(db, party, reported)).toMatchObject({
      outcome: 'failed',
      body: 'Verified the journal.',
      report: true
    })
    const failed = worker()
    db.failWorkerStart(failed, 'verification', 'Verification exited with code 1.')
    expect(readWorkerDockResult(db, party, failed)).toMatchObject({
      body: 'Verification exited with code 1.',
      report: false
    })
  })

  it('shares 200 durable failure acknowledgments across reopen and another paired client', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-dock-'))
    db.close()
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    let other: OrchestrationDb | undefined
    try {
      for (let i = 0; i < 200; i++) {
        report(worker(), 'failed')
      }
      const captured = read().identities.map((row) => ({
        dispatchId: row.dispatchId,
        settlement: row.settlement!
      }))
      const anchor = read().identities[150].id
      db.close()
      db = new OrchestrationDb(join(directory, 'orchestration.db'))
      expect(read().identities).toHaveLength(200)
      expect(read().identities[150].id).toBe(anchor)
      other = new OrchestrationDb(join(directory, 'orchestration.db'))
      const concurrent = worker()
      report(concurrent, 'failed')
      acknowledgeWorkerDock(other, { party, settlements: captured, acknowledged: true })
      expect(read().identities.map((row) => row.dispatchId)).toEqual([concurrent])
    } finally {
      other?.close()
      db.close()
      db = new OrchestrationDb(':memory:')
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('keeps old open attempts eligible after newer successes, with bounded details', () => {
    for (let i = 0; i < 75; i++) {
      worker()
    }
    for (let i = 0; i < 200; i++) {
      report(worker(), 'succeeded')
    }
    const snapshot = read()
    expect(snapshot.identities).toHaveLength(75)
    expect(snapshot.rows).toHaveLength(50)
    expect(snapshot.rows[0]).toMatchObject({
      state: 'starting',
      model: 'recorded-model',
      title: 'Verify journal writes'
    })
    const next = readWorkerDock(db, {
      party,
      anchor: snapshot.identities[60].id,
      direction: 'after',
      revision: snapshot.revision
    })
    expect(next.rows).toHaveLength(15)
    expect(next.rows[0].id).toBe(snapshot.identities[60].id)
  })

  it('retains a success until its accepted report is readable, independent of mailbox consumption', () => {
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?").run(id)
    expect(read().rows[0].state).toBe('saving')
    expect(readWorkerDockResult(db, party, id)).toBeNull()
    report(id, 'succeeded')
    db.db.prepare("UPDATE messages SET read = 1, delivered_at = datetime('now')").run()
    expect(read().identities).toEqual([])
    expect(readWorkerDockResult(db, party, id)).toMatchObject({
      outcome: 'succeeded',
      body: 'Verified the journal.'
    })
  })

  it('clears captured failures only, persists acknowledgments, and restores the same settlement', () => {
    const first = worker()
    report(first, 'failed')
    const captured = read().identities.map((row) => ({
      dispatchId: row.dispatchId,
      settlement: row.settlement!
    }))
    const concurrent = worker()
    report(concurrent, 'failed')
    acknowledgeWorkerDock(db, { party, settlements: captured, acknowledged: true })
    installWorkerDockSchema.call(db)
    expect(read().identities.map((row) => row.dispatchId)).toEqual([concurrent])
    expect(readWorkerDockResult(db, party, first)?.acknowledged).toBe(true)
    acknowledgeWorkerDock(db, { party, settlements: captured, acknowledged: false })
    expect(read().identities).toHaveLength(2)
    expect(db.getWorkerDispatch(first)?.state).toBe('failed')
  })

  it('backfills on the next open when an install stopped before its backfill committed', () => {
    const cleared = worker()
    report(cleared, 'failed')
    const settlement = read().rows[0].settlement!
    acknowledgeWorkerDock(db, {
      party,
      settlements: [{ dispatchId: cleared, settlement }],
      acknowledged: true
    })
    const open = worker()
    db.db.exec('DROP TABLE IF EXISTS worker_dock_backfill; DELETE FROM worker_dock_facts')
    expect(read().identities).toEqual([])
    installWorkerDockSchema.call(db)
    expect(read().identities.map((row) => row.dispatchId)).toEqual([open])
    expect(readWorkerDockResult(db, party, cleared)).toMatchObject({ acknowledged: true })
    db.db.prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?").run(open)
    db.db.exec('DELETE FROM worker_dock_facts')
    installWorkerDockSchema.call(db)
    expect(read().identities).toEqual([])
  })

  it('shows a requested stop as stopping, then drops it once it stopped', () => {
    const id = worker()
    db.db.prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?").run(id)
    db.beginWorkerStop(id, 'epoch_1')
    expect(read().rows[0]?.state).toBe('stopping')
    db.settleWorkerStop(id)
    expect(read().rows).toEqual([])
  })

  it('rolls projection changes back with lifecycle writes, and keeps status age stable on stage updates', () => {
    const id = worker()
    const before = read()
    expect(() =>
      runLifecycleWriteTransaction(db.db, 'test_rollback', () => {
        db.db.prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?").run(id)
        throw new Error('rollback')
      })
    ).toThrow('rollback')
    expect(read()).toEqual(before)
    db.db
      .prepare(
        "UPDATE worker_dispatches SET stage = 'checking', updated_at = '2026-11-14T14:00:00Z' WHERE dispatch_id = ?"
      )
      .run(id)
    expect(read().rows[0].changedAt).toBe(before.rows[0].changedAt)
  })

  it('updates a visible source through lifecycle settlement, Clear and restore', async () => {
    if (!isOrcaSessionId(session)) {
      throw new Error('Invalid source session')
    }
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'Verify the journal' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: session },
      maxDepth: 10,
      taskId: task.id,
      startOptions: { agent: 'codex' }
    })
    const snapshots: ReturnType<typeof read>[] = []
    const stop = subscribeWorkerDock(db, party, (snapshot) => snapshots.push(snapshot))
    try {
      db.failWorkerStart(dispatch.id, 'verification', 'Verification exited with code 1.')
      await Promise.resolve()
      await Promise.resolve()
      expect(snapshots.at(-1)?.rows[0]).toMatchObject({
        dispatchId: dispatch.id,
        state: 'failed',
        reason: 'Verification exited with code 1.'
      })
      const settlements = snapshots
        .at(-1)!
        .identities.map((row) => ({ dispatchId: row.dispatchId, settlement: row.settlement! }))
      acknowledgeWorkerDock(db, { party, settlements, acknowledged: true })
      await Promise.resolve()
      await Promise.resolve()
      expect(snapshots.at(-1)?.identities).toEqual([])
      acknowledgeWorkerDock(db, { party, settlements, acknowledged: false })
      await Promise.resolve()
      await Promise.resolve()
      expect(snapshots.at(-1)?.rows[0]).toMatchObject({ dispatchId: dispatch.id, state: 'failed' })
    } finally {
      stop()
    }
  })
})
