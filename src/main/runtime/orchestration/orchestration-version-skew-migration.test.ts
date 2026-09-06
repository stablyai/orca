import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID, OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { SCHEMA_VERSION } from './db/contract-constants'

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

  it('does not repair an incomplete schema written by a future binary', () => {
    const dbPath = createLegacySchemaClaimingVersion(20)
    const raw = new Database(dbPath)

    expect(resolveOrchestrationMigrationStartVersion(raw, 20, 19)).toBe(20)
    expect(raw.pragma('user_version', { simple: true })).toBe(20)

    raw.close()
  })

  it('repairs recovery columns missing from a partially-upgraded v32 schema', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v32-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(
      'ALTER TABLE worker_terminal_resources DROP COLUMN recovery_attempt_count; ALTER TABLE worker_terminal_resources DROP COLUMN last_recovery_at;'
    )
    raw.pragma('user_version = 32')
    expect(resolveOrchestrationMigrationStartVersion(raw, 32, 32)).toBe(6)
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.db.pragma('table_info(worker_terminal_resources)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'recovery_attempt_count' }),
        expect.objectContaining({ name: 'last_recovery_at' })
      ])
    )
    expect(db.db.pragma('table_info(messages)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'pointer_enter_pending' }),
        expect.objectContaining({ name: 'pointer_pty_id' }),
        expect.objectContaining({ name: 'pointer_process_incarnation' })
      ])
    )
    expect(
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_pending_pointer_enter'"
        )
        .get()
    ).toBeDefined()
  })

  // The two v32 recovery columns were listed as unversioned, so every shipped database below v32
  // read as v6 and replayed the whole chain, re-running the v23 resource backfill over live rows.
  it('starts a genuine pre-v32 database at its own version, not the v6 floor', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v31-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(
      'ALTER TABLE worker_terminal_resources DROP COLUMN recovery_attempt_count; ALTER TABLE worker_terminal_resources DROP COLUMN last_recovery_at;'
    )
    raw.pragma('user_version = 31')
    expect(resolveOrchestrationMigrationStartVersion(raw, 31, SCHEMA_VERSION)).toBe(31)
    raw.close()
  })

  it('creates fresh delivery mailboxes with a non-null schema invariant', () => {
    db = new OrchestrationDb(':memory:')

    expect(db.db.pragma('table_info(deliveries)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mailbox_handle', type: 'TEXT', notnull: 1 })
      ])
    )
  })

  it('repairs a nullable mailbox column written by an incomplete v34 schema', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v34-delivery-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(`
      DROP INDEX idx_deliveries_one_outstanding;
      ALTER TABLE deliveries DROP COLUMN mailbox_handle;
      ALTER TABLE deliveries ADD COLUMN mailbox_handle TEXT;
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding';
    `)
    raw.pragma('user_version = 34')
    expect(resolveOrchestrationMigrationStartVersion(raw, 34, SCHEMA_VERSION)).toBe(6)
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('table_info(deliveries)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'mailbox_handle', notnull: 1 })])
    )
  })

  it('backfills stable mailbox addresses for v33 Run deliveries', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v33-delivery-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'v33 Delivery',
      coordinatorHandle: 'term_v33',
      coordinatorPaneKey: 'tab_v33:leaf_v33'
    })
    db.insertMessage({ from: 'term_worker', to: `run:${run.id}`, subject: 'queued', runId: run.id })
    const deliveryId = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!.delivery.id
    const originalMessageIds = db.getDeliveryRaw(deliveryId)!.message_ids
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(`
      DROP INDEX idx_deliveries_one_outstanding;
      ALTER TABLE deliveries DROP COLUMN mailbox_handle;
      UPDATE deliveries
      SET status = 'acknowledged',
          created_at = '2026-01-02 03:04:05',
          acknowledged_at = '2026-01-02 04:05:06'
      WHERE id = '${deliveryId}';
      INSERT INTO deliveries (
        id, run_id, consumer_generation, message_ids, status, created_at, acknowledged_at
      ) VALUES
        ('delivery_v33_outstanding', '${run.id}', ${run.consumer_generation}, '["msg_outstanding"]', 'outstanding', '2026-02-03 04:05:06', NULL),
        ('delivery_v33_fenced', '${run.id}', ${run.consumer_generation}, '["msg_fenced"]', 'fenced', '2026-03-04 05:06:07', NULL);
    `)
    raw.pragma('user_version = 33')
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('table_info(deliveries)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mailbox_handle', type: 'TEXT', notnull: 1 })
      ])
    )
    const migratedDeliveries = db.db
      .prepare(
        `SELECT id, run_id, mailbox_handle, consumer_generation, message_ids,
                status, created_at, acknowledged_at
         FROM deliveries`
      )
      .all()
    expect(migratedDeliveries).toHaveLength(3)
    expect(migratedDeliveries).toEqual(
      expect.arrayContaining([
        {
          id: deliveryId,
          run_id: run.id,
          mailbox_handle: `run:${run.id}`,
          consumer_generation: run.consumer_generation,
          message_ids: originalMessageIds,
          status: 'acknowledged',
          created_at: '2026-01-02 03:04:05',
          acknowledged_at: '2026-01-02 04:05:06'
        },
        {
          id: 'delivery_v33_fenced',
          run_id: run.id,
          mailbox_handle: `run:${run.id}`,
          consumer_generation: run.consumer_generation,
          message_ids: '["msg_fenced"]',
          status: 'fenced',
          created_at: '2026-03-04 05:06:07',
          acknowledged_at: null
        },
        {
          id: 'delivery_v33_outstanding',
          run_id: run.id,
          mailbox_handle: `run:${run.id}`,
          consumer_generation: run.consumer_generation,
          message_ids: '["msg_outstanding"]',
          status: 'outstanding',
          created_at: '2026-02-03 04:05:06',
          acknowledged_at: null
        }
      ])
    )
    const deliveryIndexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deliveries'")
      .all() as { name: string }[]
    expect(deliveryIndexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['idx_deliveries_one_outstanding', 'idx_deliveries_run_created'])
    )
    expect(() =>
      db!.db
        .prepare(
          `INSERT INTO deliveries (
             id, run_id, mailbox_handle, consumer_generation, message_ids
           ) VALUES (?, ?, ?, ?, '[]')`
        )
        .run('delivery_v34_duplicate', run.id, `run:${run.id}`, run.consumer_generation)
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('cleans additive lifecycle rows when a v30 writer resets tasks before re-upgrade', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v30-reset-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'reset by an older writer' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.recordAttemptObservation({
      id: 'observation_before_v30_reset',
      dispatchId: started.dispatch.id,
      sequence: 0,
      authorityId: 'home',
      authorityClock: 'home',
      facet: 'process_turn',
      payload: { process: 'running', turn: 'working' },
      homeReceivedAt: 1
    })
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    // v30 resetTasks predates both additive tables, so it only deletes their legacy parents.
    raw.exec(`
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
    `)
    raw.pragma('user_version = 30')
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.prepare('SELECT * FROM attempt_observation_facts').all()).toEqual([])
  })
  it('repairs a v33 schema missing the pointer-enter column', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-version-skew-v33-pointer-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(
      'DROP INDEX IF EXISTS idx_messages_pending_pointer_enter; ALTER TABLE messages DROP COLUMN pointer_enter_pending;'
    )
    raw.pragma('user_version = 33')
    expect(resolveOrchestrationMigrationStartVersion(raw, 33, SCHEMA_VERSION)).toBe(6)
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(
      (db.db.pragma('table_info(messages)') as { name: string }[]).map(({ name }) => name)
    ).toContain('pointer_enter_pending')
  })

  it('indexes pending pointer Enters on the predicate their query uses', () => {
    db = new OrchestrationDb(':memory:')
    const index = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_messages_pending_pointer_enter'")
      .get() as { sql: string } | undefined

    expect(index?.sql).toContain('pointer_enter_pending > 0')
  })

  it('keeps a downgraded binary able to write Deliveries against a v34 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-downgrade-delivery-'))
    db = new OrchestrationDb(join(tempDir, 'orchestration.db'))
    const run = db.createRun({
      objective: 'downgrade',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_c:aaaaaaaa-aaaa-4aaa-8aaa-000000000009'
    })
    // Verbatim statement shape from a pre-v34 binary, which does not know mailbox_handle.
    const insertLegacyDelivery = (id: string): void => {
      db!.db
        .prepare(
          'INSERT INTO deliveries (id, run_id, consumer_generation, message_ids) VALUES (?, ?, ?, ?)'
        )
        .run(id, run.id, 1, '[]')
    }

    expect(() => insertLegacyDelivery('delivery_old_binary')).not.toThrow()
    // A second outstanding legacy row must not collide on the empty mailbox handle either.
    expect(() => insertLegacyDelivery('delivery_old_binary_2')).not.toThrow()
  })

  // Why: v34 early-returns at >= 34 and every index probe uses IF NOT EXISTS, so a DB the pre-fix
  // build already stamped v34 kept the old shape until v35 repaired it against the stored SQL.
  it('repairs deliveries a pre-fix build already stamped v34', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v34-already-stamped-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(`
      DROP TABLE deliveries;
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, mailbox_handle TEXT NOT NULL,
        consumer_generation INTEGER NOT NULL, message_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), acknowledged_at TEXT);
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding';
      CREATE INDEX idx_deliveries_run_created ON deliveries(run_id, created_at);
    `)
    raw.pragma('user_version = 34')
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.db.pragma('table_info(deliveries)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mailbox_handle', notnull: 1, dflt_value: "''" })
      ])
    )
    expect(
      (
        db.db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_deliveries_one_outstanding'")
          .get() as { sql: string }
      ).sql
    ).toContain("mailbox_handle != ''")

    const run = db.createRun({
      objective: 'already stamped',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_c:aaaaaaaa-aaaa-4aaa-8aaa-000000000010'
    })
    expect(() =>
      db!.db
        .prepare(
          'INSERT INTO deliveries (id, run_id, consumer_generation, message_ids) VALUES (?, ?, ?, ?)'
        )
        .run('delivery_after_v35', run.id, 1, '[]')
    ).not.toThrow()
  })

  it('rewrites a pointer-enter index a v34 database built on the = 1 predicate', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v34-pointer-predicate-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(`
      DROP INDEX IF EXISTS idx_messages_pending_pointer_enter;
      CREATE INDEX idx_messages_pending_pointer_enter
        ON messages(to_handle, sequence)
        WHERE read = 0 AND pointer_enter_pending = 1;
    `)
    raw.pragma('user_version = 34')
    raw.close()

    db = new OrchestrationDb(dbPath)
    const sql = (
      db.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_messages_pending_pointer_enter'")
        .get() as { sql: string }
    ).sql
    expect(sql).toContain('pointer_enter_pending > 0')
  })

  it('treats a v35 stamp over the wrong index predicate as skew', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v35-predicate-skew-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.exec(`
      DROP INDEX IF EXISTS idx_deliveries_one_outstanding;
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding';
    `)
    expect(resolveOrchestrationMigrationStartVersion(raw, 35, SCHEMA_VERSION)).toBe(6)
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(
      (
        db.db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_deliveries_one_outstanding'")
          .get() as { sql: string }
      ).sql
    ).toContain("mailbox_handle != ''")
  })
})
