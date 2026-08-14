import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

describe('federation acknowledgment migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('adds a zeroed durable acknowledgment watermark to v26 dispatches', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-federation-ack-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('ALTER TABLE federated_dispatches DROP COLUMN to_home_acknowledged_sequence')
    oldDb.pragma('user_version = 26')
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 26, 28)).toBe(26)
    oldDb
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           protocol_version, to_home_imported_sequence
         ) VALUES ('ctx_migrated', 'env', 'worker', 'peer', 3, 2)`
      )
      .run()
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(28)
    expect(db.getFederatedDispatch('ctx_migrated')).toMatchObject({
      to_home_imported_sequence: 2,
      to_home_acknowledged_sequence: 0,
      terminal_ack_recovery_state: 'pending',
      terminal_ack_recovery_attempts: 0,
      terminal_ack_recovery_next_at_ms: 0,
      terminal_ack_recovery_error_code: null
    })
  })

  it('adds durable terminal recovery policy state to v27 dispatches', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-federation-recovery-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec(`
      ALTER TABLE federated_dispatches DROP COLUMN terminal_ack_recovery_error_code;
      ALTER TABLE federated_dispatches DROP COLUMN terminal_ack_recovery_next_at_ms;
      ALTER TABLE federated_dispatches DROP COLUMN terminal_ack_recovery_attempts;
      ALTER TABLE federated_dispatches DROP COLUMN terminal_ack_recovery_state;
    `)
    oldDb.pragma('user_version = 27')
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 27, 28)).toBe(27)
    oldDb
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           protocol_version, to_home_imported_sequence, to_home_acknowledged_sequence
         ) VALUES ('ctx_retry', 'env', 'worker', 'peer', 3, 2, 1)`
      )
      .run()
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(28)
    expect(db.getFederatedDispatch('ctx_retry')).toMatchObject({
      to_home_imported_sequence: 2,
      to_home_acknowledged_sequence: 1,
      terminal_ack_recovery_state: 'pending',
      terminal_ack_recovery_attempts: 0,
      terminal_ack_recovery_next_at_ms: 0,
      terminal_ack_recovery_error_code: null
    })
  })
})
