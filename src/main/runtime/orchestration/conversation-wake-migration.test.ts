import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('conversation wake schema migration', () => {
  let root: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves v22 Run mail while adding generation-scoped wake state', () => {
    root = mkdtempSync(join(tmpdir(), 'orca-conversation-wake-'))
    const path = join(root, 'orchestration.db')
    const seeded = new OrchestrationDb(path)
    const run = seeded.createRun({
      objective: 'Preserve this Run',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const task = seeded.createTask({ spec: 'Preserve task', runId: run.id })
    const dispatch = seeded.createDispatchContext(task.id, 'term-worker')
    const message = seeded.insertMessage({
      from: `dispatch:${dispatch.id}`,
      to: `run:${run.id}`,
      subject: 'Preserve mail',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      runId: run.id
    })
    seeded.close()

    const old = new Database(path)
    old.exec(`
      DROP TABLE conversation_wake_jobs;
      DROP TABLE conversation_wake_provenance;
      DROP TABLE conversation_wake_bindings;
    `)
    old.pragma('user_version = 22')
    old.close()

    db = new OrchestrationDb(path)
    const sqlite = (db as unknown as { db: Database.Database }).db
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'conversation_wake_bindings', 'conversation_wake_jobs',
           'conversation_wake_provenance'
         )
         ORDER BY name`
      )
      .all() as { name: string }[]

    expect(sqlite.pragma('user_version', { simple: true })).toBe(24)
    expect(tables.map((row) => row.name)).toEqual([
      'conversation_wake_bindings',
      'conversation_wake_jobs',
      'conversation_wake_provenance'
    ])
    expect(db.getRun(run.id)).toMatchObject({ objective: 'Preserve this Run' })
    expect(db.getTask(task.id)).toMatchObject({ spec: 'Preserve task' })
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({ task_id: task.id })
    expect(db.getMessageById(message.id)).toMatchObject({
      subject: 'Preserve mail',
      read: 0,
      delivered_at: null
    })
  })

  it('preserves v23 jobs but quarantines acceptance without finalization proof', () => {
    root = mkdtempSync(join(tmpdir(), 'orca-conversation-wake-v23-'))
    const path = join(root, 'orchestration.db')
    const seeded = new OrchestrationDb(path)
    const run = seeded.createRun({
      objective: 'Preserve accepted wake',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab:22222222-2222-4222-8222-222222222222'
    })
    seeded.bindConversationWakeTarget({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      provider: 'old-provider',
      conversationId: 'old-conversation'
    })
    const task = seeded.createTask({ spec: 'Preserve accepted task', runId: run.id })
    const dispatch = seeded.createDispatchContext(task.id, 'term-worker')
    const message = seeded.insertMessage({
      from: `dispatch:${dispatch.id}`,
      to: `run:${run.id}`,
      subject: 'Old accepted wake',
      type: 'worker_done',
      runId: run.id
    })
    seeded.recordConversationWakeProvenance({
      messageId: message.id,
      taskId: task.id,
      dispatchId: dispatch.id,
      source: 'current_dispatch'
    })
    const wake = seeded.enqueueConversationWakeJob(message.id)!.job
    seeded.close()

    const old = new Database(path)
    old.exec(`
      DROP INDEX idx_conversation_wake_job_generation;
      DROP INDEX idx_conversation_wake_jobs_actionable;
      ALTER TABLE conversation_wake_jobs RENAME TO conversation_wake_jobs_v24_seed;
      CREATE TABLE conversation_wake_jobs (
        wake_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL,
        consumer_generation INTEGER NOT NULL, provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL, message_type TEXT NOT NULL,
        task_id TEXT, dispatch_id TEXT, status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0, provider_turn_id TEXT,
        acceptance_lease TEXT, lease_expires_at INTEGER, next_attempt_at INTEGER,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        submitted_at TEXT
      );
      INSERT INTO conversation_wake_jobs
        SELECT * FROM conversation_wake_jobs_v24_seed;
      DROP TABLE conversation_wake_jobs_v24_seed;
      UPDATE conversation_wake_jobs
        SET status = 'submitted', provider_turn_id = 'old-turn', submitted_at = datetime('now');
      CREATE UNIQUE INDEX idx_conversation_wake_job_generation
        ON conversation_wake_jobs(message_id, consumer_generation);
      CREATE INDEX idx_conversation_wake_jobs_actionable
        ON conversation_wake_jobs(status, created_at);
      DROP TABLE conversation_wake_provenance;
    `)
    old.pragma('user_version = 23')
    old.close()

    db = new OrchestrationDb(path)

    expect(db.getConversationWakeJob(wake.wake_id)).toMatchObject({
      status: 'blocked_inconsistent',
      provider_turn_id: 'old-turn',
      last_error: 'v23 acceptance lacks durable provider finalization proof'
    })
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0 })
  })
})
