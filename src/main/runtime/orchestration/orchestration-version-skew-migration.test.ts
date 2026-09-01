import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID, OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('OrchestrationDb version-skew migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createLegacySchemaClaimingVersion(claimedVersion = 17): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE messages (
        id TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'heartbeat'
          )),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id TEXT,
        payload TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        sender_pane_key TEXT
      );
      CREATE UNIQUE INDEX idx_messages_id ON messages(id);
      CREATE INDEX idx_inbox ON messages(to_handle, read);
      CREATE INDEX idx_thread ON messages(thread_id);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        created_by_terminal_handle TEXT,
        task_title TEXT,
        display_name TEXT,
        spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','ready','dispatched','completed','failed','blocked')),
        deps TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE dispatch_contexts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignee_handle TEXT,
        assignee_pane_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','dispatched','completed','failed','circuit_broken')),
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT,
        dispatched_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at TEXT
      );
      CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id);
      CREATE INDEX idx_dispatch_status ON dispatch_contexts(status);

      CREATE TABLE decision_gates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','resolved','timeout')),
        resolution TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX idx_gates_task ON decision_gates(task_id);
      CREATE INDEX idx_gates_status ON decision_gates(status);

      CREATE TABLE coordinator_runs (
        id TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle','running','completed','failed')),
        coordinator_handle TEXT NOT NULL,
        poll_interval_ms INTEGER NOT NULL DEFAULT 2000,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      INSERT INTO messages (
        id, from_handle, to_handle, subject, body, type
      ) VALUES (
        'msg_legacy', 'term_worker', 'term_coord', 'retained message', 'done', 'status'
      );
      INSERT INTO tasks (
        id, created_by_terminal_handle, task_title, display_name, spec, status
      ) VALUES (
        'task_legacy', 'term_coord', 'Legacy task', 'Legacy task', 'retained task', 'dispatched'
      );
      INSERT INTO dispatch_contexts (
        id, task_id, assignee_handle, assignee_pane_key, status
      ) VALUES (
        'ctx_legacy', 'task_legacy', 'term_worker', 'tab_legacy:leaf_legacy', 'dispatched'
      );
      INSERT INTO decision_gates (
        id, task_id, question
      ) VALUES (
        'gate_legacy', 'task_legacy', 'retained gate'
      );
    `)
    raw.pragma(`user_version = ${claimedVersion}`)
    raw.close()
    return dbPath
  }

  it('repairs retained v6 rows when the database already claims v17', () => {
    const dbPath = createLegacySchemaClaimingVersion()
    db = new OrchestrationDb(dbPath)

    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id
    expect(adoptedRunId).toBeTruthy()
    expect(db.getRun(LEGACY_RUN_ID)).toMatchObject({ legacy: 1 })
    expect(db.getMessageById('msg_legacy')).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'legacy_direct'
    })
    expect(db.getTask('task_legacy')).toMatchObject({ run_id: adoptedRunId })
    expect(db.getDispatchContextById('ctx_legacy')).toMatchObject({
      run_id: adoptedRunId,
      contract_version: LEGACY_CONTRACT_VERSION
    })
    expect(db.getGate('gate_legacy')).toMatchObject({ run_id: adoptedRunId })

    const run = db.createRun({
      objective: 'verify repaired orchestration',
      coordinatorHandle: 'term_coord_v2',
      coordinatorPaneKey: 'tab_v2:leaf_coord'
    })
    const task = db.createTask({ spec: 'reply with ack', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker_v2', 'tab_v2:leaf_worker')
    const question = db.createQuestion({
      runId: run.id,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker_v2',
      question: 'ack?'
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })
    expect(question.message.type).toBe('question')
    expect(delivery?.messages.map((message) => message.id)).toContain(question.message.id)

    db.close()
    db = undefined
    db = new OrchestrationDb(dbPath)
    expect(db.listTasks({ runId: adoptedRunId }).map((row) => row.id)).toEqual(['task_legacy'])
    expect(db.getRun(run.id)).toBeDefined()
    expect(db.getQuestion(question.message.id)).toMatchObject({ status: 'pending' })
  })

  it('backfills accepted worker-report provenance while upgrading v30', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-worker-report-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'Pre-v31 worker report',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const openDb = db
    const startWorker = (spec: string, handle: string) => {
      const task = openDb.createTask({ spec, runId: run.id })
      const { dispatch } = openDb.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1
      })
      openDb.prepareStartingWorkerAuthority({
        dispatchId: dispatch.id,
        handle,
        paneKey: `tab_${handle}:leaf_${handle}`,
        processIncarnation: `runtime:${handle}:1`,
        worktreeId: 'repo::worktree',
        effects: [],
        setupState: 'completed',
        terminalOwnership: 'created'
      })
      return { task, dispatch }
    }
    const succeeded = startWorker('complete before update', 'term_succeeded')
    db.markWorkerDispatchReady(succeeded.dispatch.id)
    db.settleWorkerReport({
      taskId: succeeded.task.id,
      dispatchId: succeeded.dispatch.id,
      outcome: 'succeeded',
      result: 'completed before v31'
    })
    const failed = startWorker('fail before update', 'term_failed')
    db.markWorkerDispatchReady(failed.dispatch.id)
    const failedMessage = db.insertMessage({
      from: 'term_failed',
      to: `run:${run.id}`,
      subject: 'Failed',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: failed.task.id,
        dispatchId: failed.dispatch.id,
        outcome: 'failed'
      }),
      runId: run.id
    })
    db.settleWorkerReport({
      taskId: failed.task.id,
      dispatchId: failed.dispatch.id,
      outcome: 'failed',
      result: 'legacy failed worker report'
    })
    const spoofed = startWorker('spoof before update', 'term_spoofed')
    db.failWorkerStart(
      spoofed.dispatch.id,
      'terminal_ready',
      JSON.stringify({ provenance: 'worker_report', messageId: failedMessage.id })
    )
    db.resetMessages()
    const markerField = startWorker('reserved marker field', 'term_marker_field')
    db.markWorkerDispatchReady(markerField.dispatch.id)
    const markerFieldMessage = db.insertMessage({
      from: 'term_marker_field',
      to: `run:${run.id}`,
      subject: 'Failed with extra field',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: markerField.task.id,
        dispatchId: markerField.dispatch.id,
        outcome: 'failed',
        _orcaLifecycleRejection: {}
      }),
      runId: run.id
    })
    db.settleWorkerReport({
      taskId: markerField.task.id,
      dispatchId: markerField.dispatch.id,
      outcome: 'failed',
      result: JSON.stringify({
        provenance: 'worker_report',
        messageId: markerFieldMessage.id
      })
    })
    db.abandonWorkerDispatch(markerField.dispatch.id)
    db.db.prepare('UPDATE tasks SET result = NULL WHERE id = ?').run(markerField.task.id)
    const rejected = startWorker('rejected lifecycle marker', 'term_rejected')
    const rejectedMessage = db.insertMessage({
      from: 'term_rejected',
      to: `run:${run.id}`,
      subject: 'Rejected',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: rejected.task.id,
        dispatchId: rejected.dispatch.id,
        outcome: 'failed',
        _orcaLifecycleRejection: { code: 'sender_not_assignee', reason: 'wrong pane' }
      }),
      runId: run.id
    })
    db.failWorkerStart(
      rejected.dispatch.id,
      'terminal_ready',
      JSON.stringify({ provenance: 'worker_report', messageId: rejectedMessage.id })
    )
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec('ALTER TABLE worker_dispatches DROP COLUMN worker_report_settled_at')
    raw.pragma('user_version = 30')
    raw.close()

    db = new OrchestrationDb(dbPath)
    const provenance = db.db
      .prepare(
        `SELECT dispatch_id, worker_report_settled_at
           FROM worker_dispatches
          WHERE dispatch_id IN (?, ?, ?, ?, ?)
          ORDER BY rowid`
      )
      .all(
        succeeded.dispatch.id,
        failed.dispatch.id,
        spoofed.dispatch.id,
        markerField.dispatch.id,
        rejected.dispatch.id
      )
    expect(provenance).toEqual([
      {
        dispatch_id: succeeded.dispatch.id,
        worker_report_settled_at: expect.any(String)
      },
      { dispatch_id: failed.dispatch.id, worker_report_settled_at: expect.any(String) },
      { dispatch_id: spoofed.dispatch.id, worker_report_settled_at: null },
      {
        dispatch_id: markerField.dispatch.id,
        worker_report_settled_at: expect.any(String)
      },
      { dispatch_id: rejected.dispatch.id, worker_report_settled_at: null }
    ])
    let barrierError: unknown
    try {
      db.requireRunWorkerDisposition(run.id)
    } catch (error) {
      barrierError = error
    }
    expect(barrierError).toMatchObject({
      code: 'worker_disposition_required',
      data: {
        dispatchIds: [succeeded.dispatch.id, failed.dispatch.id, markerField.dispatch.id]
      }
    })
  })

  it('does not repair an incomplete schema written by a future binary', () => {
    const dbPath = createLegacySchemaClaimingVersion(20)
    const raw = new Database(dbPath)

    expect(resolveOrchestrationMigrationStartVersion(raw, 20, 19)).toBe(20)
    expect(raw.pragma('user_version', { simple: true })).toBe(20)

    raw.close()
  })
})
