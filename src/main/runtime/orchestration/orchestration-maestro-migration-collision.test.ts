import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

describe('Maestro and upstream migration history reconciliation', () => {
  const directories: string[] = []
  const databases: { close(): void }[] = []

  afterEach(() => {
    for (const db of databases.splice(0).toReversed()) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function historicalDatabase(lineage: 'maestro-v36' | 'upstream-v38') {
    const directory = mkdtempSync(join(tmpdir(), 'orca-schema-collision-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const raw = new Database(path)
    raw.exec(readFileSync(new URL(`./fixtures/schema-${lineage}.sql`, import.meta.url), 'utf8'))
    raw.exec(`
      INSERT INTO runs(id, objective) VALUES ('run_sentinel', 'preserved objective');
      INSERT INTO tasks(id, run_id, spec) VALUES ('task_sentinel', 'run_sentinel', 'preserved task');
      INSERT INTO worker_terminal_resources(
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation
      ) VALUES ('resource_sentinel', 'dispatch_sentinel', 'dispatch_sentinel', 'term_sentinel', 'pty:1');
    `)
    return { path, raw }
  }

  for (const lineage of ['maestro-v36', 'upstream-v38'] as const) {
    it(`preserves ${lineage} rows while upgrading and reopening the union schema`, () => {
      const { path, raw } = historicalDatabase(lineage)
      if (lineage === 'maestro-v36') {
        raw.exec(`UPDATE tasks SET purpose = 'operational', operational_outcome = 'unverifiable';
          UPDATE worker_terminal_resources SET release_state = 'retained_for_review',
            retention_owner = 'owner', retention_expires_at = '2030-01-01', review_id = 'review';`)
      } else {
        raw.exec(`UPDATE worker_terminal_resources SET endpoint_id = 'endpoint',
          endpoint_incarnation = 'incarnation', recovery_attempt_count = 7, last_recovery_at = '2026-09-01';`)
      }
      const task =
        lineage === 'maestro-v36'
          ? raw
              .prepare('SELECT spec, purpose, operational_outcome FROM tasks WHERE id = ?')
              .get('task_sentinel')
          : undefined
      const before = raw.prepare('SELECT objective FROM runs WHERE id = ?').get('run_sentinel')
      const resource = raw
        .prepare('SELECT * FROM worker_terminal_resources WHERE id = ?')
        .get('resource_sentinel')
      expect(
        resolveOrchestrationMigrationStartVersion(
          raw,
          lineage === 'maestro-v36' ? 36 : 38,
          SCHEMA_VERSION
        )
      ).toBe(lineage === 'maestro-v36' ? 30 : 38)
      raw.close()
      const migrated = new OrchestrationDb(path)
      expect(migrated.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(
        migrated.db.prepare('SELECT objective FROM runs WHERE id = ?').get('run_sentinel')
      ).toEqual(before)
      if (task) {
        expect(
          migrated.db
            .prepare('SELECT spec, purpose, operational_outcome FROM tasks WHERE id = ?')
            .get('task_sentinel')
        ).toEqual(task)
      }
      expect(migrated.getWorkerTerminalResource('resource_sentinel')).toMatchObject(resource!)
      expect(migrated.hasColumn('worker_terminal_resources', 'endpoint_incarnation')).toBe(true)
      expect(migrated.hasColumn('worker_terminal_resources', 'retention_owner')).toBe(true)
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get('trg_runs_forget_completion')
      ).toEqual({ name: 'trg_runs_forget_completion' })
      expect(migrated.db.pragma('foreign_key_check')).toEqual([])
      expect(migrated.db.pragma('integrity_check', { simple: true })).toBe('ok')
      const finalResource = migrated.getWorkerTerminalResource('resource_sentinel')
      migrated.close()
      const reopened = new OrchestrationDb(path)
      databases.push(reopened)
      expect(reopened.getWorkerTerminalResource('resource_sentinel')).toEqual(finalResource)
      expect(reopened.db.pragma('foreign_key_check')).toEqual([])
    })
  }

  it('repairs partial mutation and task columns while preserving existing values', () => {
    const { path, raw } = historicalDatabase('maestro-v36')
    raw.close()
    const initial = new OrchestrationDb(path)
    initial.db.exec(`DROP INDEX idx_maestro_terminal_lease_transfer_mutation;
      INSERT INTO maestro_terminal_lease_transfer_receipts(request_id, receipt_json, mutation_caller_fingerprint)
        VALUES ('partial-transfer', '{"kept":true}', 'kept-caller');
      ALTER TABLE maestro_terminal_lease_transfer_receipts DROP COLUMN mutation_request_id;
      ALTER TABLE tasks DROP COLUMN operational_outcome;
      ALTER TABLE tasks DROP COLUMN successor_task_id;
      ALTER TABLE worker_terminal_resources DROP COLUMN review_id;`)
    initial.close()
    const repaired = new OrchestrationDb(path)
    databases.push(repaired)
    expect(repaired.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(repaired.hasColumn('tasks', 'operational_outcome')).toBe(true)
    expect(repaired.hasColumn('tasks', 'successor_task_id')).toBe(true)
    expect(repaired.hasColumn('worker_terminal_resources', 'review_id')).toBe(true)
    expect(
      repaired.db
        .prepare(
          'SELECT mutation_caller_fingerprint, mutation_request_id FROM maestro_terminal_lease_transfer_receipts WHERE request_id = ?'
        )
        .get('partial-transfer')
    ).toEqual({ mutation_caller_fingerprint: 'kept-caller', mutation_request_id: null })
    expect(repaired.db.pragma('foreign_key_check')).toEqual([])
    expect(repaired.db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('opens historical lease receipts without mutation columns before rebuilding their index', () => {
    const { path, raw } = historicalDatabase('maestro-v36')
    raw.exec(`DROP INDEX idx_maestro_terminal_lease_transfer_mutation;
      DROP TABLE maestro_terminal_lease_transfer_receipts;
      CREATE TABLE maestro_terminal_lease_transfer_receipts (
        request_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO maestro_terminal_lease_transfer_receipts(request_id, receipt_json)
        VALUES ('old-transfer', '{"preserved":true}');
      PRAGMA user_version = 32;`)
    raw.close()
    const db = new OrchestrationDb(path)
    databases.push(db)
    expect(
      db.db
        .prepare(
          'SELECT receipt_json FROM maestro_terminal_lease_transfer_receipts WHERE request_id = ?'
        )
        .get('old-transfer')
    ).toEqual({ receipt_json: '{"preserved":true}' })
    db.db.exec(`INSERT INTO maestro_terminal_lease_transfer_receipts (
      request_id, receipt_json, mutation_caller_fingerprint, mutation_request_id, mutation_method, mutation_payload_hash
    ) VALUES ('new-transfer', '{}', 'caller', 'request', 'method', 'hash')`)
    expect(() =>
      db.db.exec(`INSERT INTO maestro_terminal_lease_transfer_receipts (
      request_id, receipt_json, mutation_caller_fingerprint, mutation_request_id, mutation_method, mutation_payload_hash
    ) VALUES ('duplicate-transfer', '{}', 'caller', 'request', 'method', 'hash')`)
    ).toThrow(/UNIQUE/)
    expect(db.db.pragma('foreign_key_check')).toEqual([])
  })
})
