import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  deleteExpiredOrchestrationRows,
  EXPIRED_ROW_SWEEPS,
  listRetiredRunCandidates
} from './settled-run-retention'
import { deleteRetiredRun, retireSettledRun, type RunPartyLiveness } from './settled-run-retirement'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

const LONG_AGO = '2000-01-01 00:00:00'
const PANE_LEAF = '11111111-1111-4111-8111-111111111111'
const nobodyIsLive: RunPartyLiveness = {
  isLiveHandle: () => false,
  isLivePane: () => false,
  waitedMailboxes: () => []
}
const liveHandle = (live: string): RunPartyLiveness => ({
  ...nobodyIsLive,
  isLiveHandle: (handle) => handle === live
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

    expect(listRetiredRunCandidates(db!, '', 10).candidates).toContain(settled.run.id)
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

  it('deletes a large settled Run a bounded page at a time, its Run row last', () => {
    const { run } = createRunWithWorker('large')
    for (let n = 0; n < 1_000; n++) {
      db!.insertMessage({
        runId: run.id,
        from: 'term_large',
        to: `run:${run.id}`,
        subject: `m${n}`
      })
    }
    for (let n = 0; n < 300; n++) {
      db!.createTask({ spec: `task ${n}`, runId: run.id })
    }
    const insertDelivery = db!.db.prepare(
      `INSERT INTO deliveries (id, run_id, consumer_generation, message_ids, status)
       VALUES (?, ?, 1, '[]', 'acknowledged')`
    )
    for (let n = 0; n < 300; n++) {
      insertDelivery.run(`delivery_${n}`, run.id)
    }
    settle(run.id)
    ageEveryTimestamp()

    // A quit midway leaves the Run, with fewer settled rows, for the next pass to finish.
    const interrupted = retireSettledRun(db!, run.id, nobodyIsLive)
    for (let step = 0; step < 12; step++) {
      expect(interrupted.next().done).toBe(false)
    }
    expect(db!.getRun(run.id)).toBeDefined()

    const steps = retireSettledRun(db!, run.id, nobodyIsLive)
    for (;;) {
      const step = steps.next()
      if (step.done) {
        expect(step.value).toBe(true)
        break
      }
      expect(db!.getRun(run.id)).toBeDefined()
    }
    expect(db!.getRun(run.id)).toBeUndefined()
    expect(count('messages WHERE run_id = ?', run.id)).toBe(0)
    expect(count('tasks WHERE run_id = ?', run.id)).toBe(0)
    expect(count('deliveries WHERE run_id = ?', run.id)).toBe(0)
    expect(count('removed_orchestration_work')).toBe(0)
  })

  it('stops retiring a Run whose coordinator pane comes back between pages', () => {
    const { run } = createRunWithWorker('reattached')
    for (let n = 0; n < 200; n++) {
      db!.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: `m${n}` })
    }
    settle(run.id)
    ageEveryTimestamp()
    let paneLive = false
    const steps = retireSettledRun(db!, run.id, {
      ...nobodyIsLive,
      isLivePane: (paneKey) => paneLive && paneKey === `tab_reattached:${PANE_LEAF}`
    })
    let step = steps.next()
    while (!step.done && count('messages WHERE run_id = ?', run.id) === 201) {
      step = steps.next()
    }
    paneLive = true
    while (!step.done) {
      step = steps.next()
    }

    expect(step.value).toBe(false)
    expect(db!.getRun(run.id)).toBeDefined()
    expect(count('messages WHERE run_id = ?', run.id)).toBeGreaterThan(0)
  })

  it('keeps a Run and its new gate when a gate opens between pages', () => {
    const { run, task } = createRunWithWorker('gated')
    for (let n = 0; n < 200; n++) {
      db!.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: `m${n}` })
    }
    settle(run.id)
    ageEveryTimestamp()
    const steps = retireSettledRun(db!, run.id, nobodyIsLive)
    let step = steps.next()
    while (!step.done && count("worker_terminal_resources WHERE id = 'resource_gated'") === 1) {
      step = steps.next()
    }
    db!.createGate({ taskId: task.id, question: 'Ship it?' })
    while (!step.done) {
      step = steps.next()
    }

    expect(step.value).toBe(false)
    expect(db!.getRun(run.id)).toBeDefined()
    expect(count("decision_gates WHERE run_id = ? AND status = 'pending'", run.id)).toBe(1)
  })

  it('keeps a Run whose Task is reopened between pages', () => {
    const { run, task } = createRunWithWorker('reopened')
    settle(run.id)
    ageEveryTimestamp()
    const steps = retireSettledRun(db!, run.id, nobodyIsLive)
    let step = steps.next()
    while (!step.done && count("worker_terminal_resources WHERE id = 'resource_reopened'") === 1) {
      step = steps.next()
    }
    db!.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    while (!step.done) {
      step = steps.next()
    }

    expect(step.value).toBe(false)
    expect(count("tasks WHERE id = ? AND status = 'ready'", task.id)).toBe(1)
  })

  it.each(['run', 'dispatch'] as const)(
    'keeps a Run whose %s mailbox gets a reader between pages',
    (mailbox) => {
      const { run, dispatchId } = createRunWithWorker(`waited_${mailbox}`)
      for (let n = 0; n < 200; n++) {
        db!.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: `m${n}` })
      }
      settle(run.id)
      ageEveryTimestamp()
      const handle = mailbox === 'run' ? `run:${run.id}` : `dispatch:${dispatchId}`
      let waiting = false
      const steps = retireSettledRun(db!, run.id, {
        ...nobodyIsLive,
        waitedMailboxes: () => (waiting ? [handle] : [])
      })
      let step = steps.next()
      // The worker's report, its question and the 200 above.
      while (!step.done && count('messages WHERE run_id = ?', run.id) === 202) {
        step = steps.next()
      }
      waiting = true
      while (!step.done) {
        step = steps.next()
      }

      expect(step.value).toBe(false)
      expect(count('messages WHERE run_id = ?', run.id)).toBeGreaterThan(0)
    }
  )

  it('keeps a Run whose settled Task result is corrected between pages', () => {
    const { run, task } = createRunWithWorker('corrected')
    settle(run.id)
    ageEveryTimestamp()
    const steps = retireSettledRun(db!, run.id, nobodyIsLive)
    let step = steps.next()
    while (!step.done && count("worker_terminal_resources WHERE id = 'resource_corrected'") === 1) {
      step = steps.next()
    }
    db!.updateTaskStatus(task.id, 'completed', 'corrected result')
    while (!step.done) {
      step = steps.next()
    }

    expect(step.value).toBe(false)
    expect(db!.getTask(task.id)?.result).toBe('corrected result')
    expect(count('dispatch_contexts WHERE run_id = ?', run.id)).toBe(1)
    // The worker's report and its question.
    expect(count('messages WHERE run_id = ?', run.id)).toBe(2)
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
        ...nobodyIsLive,
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

    expect(listRetiredRunCandidates(db!, '', 10).candidates).toEqual([])
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
