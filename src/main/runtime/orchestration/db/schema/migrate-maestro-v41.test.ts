import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { applySchemaMigrationV41 } from './migrate-maestro-v41'

describe('Maestro v41 partial schema migration', () => {
  it('restores all lease indexes when mutation columns already partially exist', () => {
    const database = new OrchestrationDb(':memory:')
    database.db.exec(`
      DROP INDEX IF EXISTS idx_maestro_terminal_leases_coordinator_generation;
      DROP INDEX IF EXISTS idx_maestro_terminal_leases_worker_attempt;
      DROP INDEX IF EXISTS idx_maestro_terminal_leases_worker_resource;
      DROP INDEX IF EXISTS idx_maestro_terminal_leases_live_terminal_owner;
      DROP INDEX IF EXISTS idx_maestro_terminal_leases_lifecycle;
      DROP INDEX IF EXISTS idx_maestro_terminal_lease_transfer_mutation;
      ALTER TABLE maestro_terminal_lease_transfer_receipts DROP COLUMN mutation_request_id;
      ALTER TABLE maestro_terminal_lease_transfer_receipts DROP COLUMN mutation_method;
      ALTER TABLE maestro_terminal_lease_transfer_receipts DROP COLUMN mutation_payload_hash;
    `)

    applySchemaMigrationV41.call(database, 40)

    const columns = (
      database.db.pragma('table_info(maestro_terminal_lease_transfer_receipts)') as {
        name: string
      }[]
    ).map((row) => row.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'mutation_caller_fingerprint',
        'mutation_request_id',
        'mutation_method',
        'mutation_payload_hash'
      ])
    )
    const indexes = database.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_maestro_terminal_lease%'
         ORDER BY name`
      )
      .all()
      .map((row) => (row as { name: string }).name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_maestro_terminal_leases_coordinator_generation',
        'idx_maestro_terminal_leases_worker_attempt',
        'idx_maestro_terminal_leases_worker_resource',
        'idx_maestro_terminal_leases_live_terminal_owner',
        'idx_maestro_terminal_leases_lifecycle',
        'idx_maestro_terminal_lease_transfer_mutation'
      ])
    )
    database.close()
  })
})
