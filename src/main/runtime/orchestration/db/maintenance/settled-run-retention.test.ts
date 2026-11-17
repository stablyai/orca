import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  deleteExpiredOrchestrationRows,
  EXPIRED_ROW_SWEEPS,
  deleteRetiredRun,
  listRetiredRunCandidates,
  type RunPartyLiveness
} from './settled-run-retention'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

const LONG_AGO = '2000-01-01 00:00:00'
const PANE_LEAF = '11111111-1111-4111-8111-111111111111'
const nobodyIsLive: RunPartyLiveness = { isLiveHandle: () => false, isLivePane: () => false }
const liveHandle = (live: string): RunPartyLiveness => ({
  isLiveHandle: (handle) => handle === live,
  isLivePane: () => false
})

describe('settled Run retention', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function count(sql: string, ...params: string[]): number {
    return Number(db!.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params)?.n)
  }

  function expireRows(): void {
    for (let sweep = 0; sweep < EXPIRED_ROW_SWEEPS; sweep++) {
      for (let after: number | null = 0; after !== null;) {
        after = deleteExpiredOrchestrationRows(db!, sweep, after, 2)
      }
    }
  }

  function ageEveryTimestamp(): void {
    const tables = db!.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    for (const table of tables) {
      for (const column of db!.db.prepare(`PRAGMA table_info(${table})`).all()) {
        const name = String(column.name)
        if (name.endsWith('_at')) {
          db!.db.exec(`UPDATE ${table} SET ${name} = '${LONG_AGO}' WHERE ${name} IS NOT NULL`)
        }
      }
    }
  }

  function createRunWithWorker(objective: string) {
    db ??= new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective,
      coordinatorHandle: `term_${objective}`,
      coordinatorPaneKey: `tab_${objective}:${PANE_LEAF}`
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { worktree: 'current' },
      runtimeEpoch: 'runtime_1',
      federation: {
        environmentId: 'environment_1',
        environmentName: 'Windows',
        peerFingerprint: 'peer_1',
        protocolVersion: 1
      },
      mutationReceipt: {
        callerFingerprint: 'caller_1',
        requestId: `request_${objective}`,
        method: 'orchestration.workerStart',
        payloadHash: 'hash_1'
      }
    })
    const dispatchId = started.dispatch.id
    db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'done' })
    db.createQuestion({ runId: run.id, dispatchId, askerHandle: 'worker', question: 'Continue?' })
    db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'question',
      payload: '{}',
      messageId: `question_${objective}`,
      remoteQuestion: true
    })
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources
           (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, ownership_state, release_state)
         VALUES (?, ?, ?, ?, 'released', 'released')`
      )
      .run(`resource_${objective}`, dispatchId, dispatchId, `term_worker_${objective}`)
    return { run, task, dispatchId }
  }

  function settle(runId: string): void {
    db!.db.prepare("UPDATE tasks SET status = 'completed' WHERE run_id = ?").run(runId)
    db!.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE run_id = ?").run(runId)
    db!.db
      .prepare(
        `UPDATE worker_dispatches SET state = 'succeeded'
         WHERE dispatch_id IN (SELECT id FROM dispatch_contexts WHERE run_id = ?)`
      )
      .run(runId)
    db!.db.prepare("UPDATE question_threads SET status = 'answered' WHERE run_id = ?").run(runId)
    db!.db
      .prepare(
        `UPDATE remote_questions SET status = 'answered'
         WHERE dispatch_id IN (SELECT id FROM dispatch_contexts WHERE run_id = ?)`
      )
      .run(runId)
    db!.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = datetime('now')
         WHERE dispatch_id IN (SELECT id FROM dispatch_contexts WHERE run_id = ?)`
      )
      .run(runId)
  }

  it('deletes a settled Run with every row it owns and keeps a live one', () => {
    const settled = createRunWithWorker('settled')
    const live = createRunWithWorker('live')
    settle(settled.run.id)
    ageEveryTimestamp()

    expect(listRetiredRunCandidates(db!, '', 10).retired).toEqual([settled.run.id])
    expect(deleteRetiredRun(db!, live.run.id, nobodyIsLive)).toBe(false)
    expect(deleteRetiredRun(db!, settled.run.id, nobodyIsLive)).toBe(true)

    expect(db!.getRun(settled.run.id)).toBeUndefined()
    expect(count('tasks WHERE run_id = ?', settled.run.id)).toBe(0)
    expect(count('messages WHERE run_id = ?', settled.run.id)).toBe(0)
    expect(count('question_threads WHERE run_id = ?', settled.run.id)).toBe(0)
    expect(count('run_coordinator_handles WHERE run_id = ?', settled.run.id)).toBe(0)
    for (const table of [
      'dispatch_contexts WHERE id = ?',
      'worker_dispatches WHERE dispatch_id = ?',
      'federated_dispatches WHERE dispatch_id = ?',
      'worker_terminal_resources WHERE owner_dispatch_id = ?',
      'remote_questions WHERE dispatch_id = ?',
      'federation_relay_items WHERE dispatch_id = ?'
    ]) {
      expect(count(table, settled.dispatchId)).toBe(0)
    }
    expect(count('removed_orchestration_work')).toBe(0)

    expect(db!.getRun(live.run.id)).toBeDefined()
    expect(db!.getTask(live.task.id)).toBeDefined()
    expect(db!.getWorkerDispatch(live.dispatchId)).toBeDefined()
    expect(count('worker_terminal_resources WHERE owner_dispatch_id = ?', live.dispatchId)).toBe(1)
  })

  it('keeps a settled Run while its coordinator, a reader of its unread mail or its worker terminal is live', () => {
    const { run } = createRunWithWorker('bound')
    db!.insertMessage({ runId: run.id, from: 'worker', to: 'term_reader', subject: 'note' })
    settle(run.id)
    ageEveryTimestamp()

    expect(deleteRetiredRun(db!, run.id, liveHandle('term_bound'))).toBe(false)
    expect(deleteRetiredRun(db!, run.id, liveHandle(`run:${run.id}`))).toBe(false)
    expect(
      deleteRetiredRun(db!, run.id, {
        isLiveHandle: () => false,
        isLivePane: (paneKey) => paneKey === `tab_bound:${PANE_LEAF}`
      })
    ).toBe(false)
    expect(deleteRetiredRun(db!, run.id, liveHandle('term_reader'))).toBe(false)
    expect(deleteRetiredRun(db!, run.id, liveHandle('term_worker_bound'))).toBe(false)
    expect(db!.getRun(run.id)).toBeDefined()
    expect(deleteRetiredRun(db!, run.id, nobodyIsLive)).toBe(true)
  })

  it('keeps a settled Run touched inside the window', () => {
    const { run } = createRunWithWorker('recent')
    settle(run.id)

    expect(listRetiredRunCandidates(db!, '', 10).retired).toEqual([])
    expect(deleteRetiredRun(db!, run.id, nobodyIsLive)).toBe(false)
    expect(db!.getRun(run.id)).toBeDefined()
  })

  it('keeps a settled Run whose worker terminal still has an armed auto-release', () => {
    const { run } = createRunWithWorker('armed')
    settle(run.id)
    ageEveryTimestamp()
    db!.db.prepare('UPDATE worker_terminal_resources SET auto_release_at = ?').run(LONG_AGO)

    expect(deleteRetiredRun(db!, run.id, nobodyIsLive)).toBe(false)
    expect(db!.getRun(run.id)).toBeDefined()
  })

  it('keeps a settled Run whose worker terminal was handed to a live Run', () => {
    const origin = createRunWithWorker('origin')
    const heir = createRunWithWorker('heir')
    settle(origin.run.id)
    db!.db
      .prepare('UPDATE worker_terminal_resources SET origin_dispatch_id = ? WHERE id = ?')
      .run(origin.dispatchId, 'resource_heir')
    ageEveryTimestamp()

    expect(deleteRetiredRun(db!, origin.run.id, nobodyIsLive)).toBe(false)
    expect(db!.getWorkerDispatch(origin.dispatchId)).toBeDefined()
    expect(db!.getRun(heir.run.id)).toBeDefined()
  })

  it('deletes a settled Run whose worker terminal moved between its own Dispatches', () => {
    const { run, dispatchId } = createRunWithWorker('origin')
    const sibling = createRunWithWorker('sibling')
    db!.db.prepare('UPDATE tasks SET run_id = ? WHERE id = ?').run(run.id, sibling.task.id)
    db!.db
      .prepare('UPDATE dispatch_contexts SET run_id = ? WHERE id = ?')
      .run(run.id, sibling.dispatchId)
    db!.db
      .prepare('UPDATE worker_terminal_resources SET origin_dispatch_id = ? WHERE id = ?')
      .run(dispatchId, 'resource_sibling')
    settle(run.id)
    ageEveryTimestamp()

    expect(deleteRetiredRun(db!, run.id, nobodyIsLive)).toBe(true)
    expect(count('worker_terminal_resources WHERE origin_dispatch_id = ?', dispatchId)).toBe(0)
  })

  it('deletes acknowledged relay items past the window except the newest of each stream', () => {
    const { dispatchId } = createRunWithWorker('relay')
    for (const messageId of ['status_2', 'status_3', 'status_4']) {
      db!.enqueueFederationRelay({
        dispatchId,
        direction: 'to_home',
        kind: 'status',
        payload: '{}',
        messageId
      })
    }
    db!.db
      .prepare('UPDATE federation_relay_items SET acked_at = ? WHERE sequence < 4')
      .run(LONG_AGO)
    db!.db
      .prepare("UPDATE federation_relay_items SET acked_at = datetime('now') WHERE sequence = 3")
      .run()

    expireRows()

    expect(
      db!
        .listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
        .map((item) => item.sequence)
    ).toEqual([3, 4])

    db!.db.prepare('UPDATE federation_relay_items SET acked_at = ?').run(LONG_AGO)
    expireRows()

    expect(
      db!
        .listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
        .map((item) => item.sequence)
    ).toEqual([4])
  })

  it('deletes settled worker rows whose Dispatch is gone, leaving no removed-work records', () => {
    db = new OrchestrationDb(':memory:')
    db.db.exec(`
      INSERT INTO worker_dispatches (dispatch_id, state, updated_at)
        VALUES ('dispatch_gone', 'succeeded', '${LONG_AGO}');
      INSERT INTO worker_terminal_resources
        (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, ownership_state, release_state, updated_at)
        VALUES ('resource_gone', 'dispatch_gone', 'dispatch_gone', 'term_gone', 'external', 'not_requested', '${LONG_AGO}');
      INSERT INTO worker_dispatches (dispatch_id, state, updated_at)
        VALUES ('dispatch_running', 'ready', '${LONG_AGO}');
      INSERT INTO removed_orchestration_work (run_id, kind, entity_id, record, removed_at)
        VALUES (NULL, 'terminal', 'resource_earlier', '{}', '${LONG_AGO}');
    `)

    expireRows()

    expect(count('worker_dispatches WHERE dispatch_id = ?', 'dispatch_gone')).toBe(0)
    expect(count('worker_terminal_resources WHERE id = ?', 'resource_gone')).toBe(0)
    expect(count('worker_dispatches WHERE dispatch_id = ?', 'dispatch_running')).toBe(1)
    expect(count('removed_orchestration_work')).toBe(0)
  })
})
