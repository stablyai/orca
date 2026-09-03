import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryRelayDatabase, openRelayDatabase } from './database.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('relay database', () => {
  it('creates every durable relay state table', async () => {
    const database = await openInMemoryRelayDatabase()
    const rows = await database.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'relay_%' ORDER BY name`
    )
    expect(rows.map((row) => row.name)).toEqual([
      'relay_admission_selector_cell_additions',
      'relay_admission_selector_intents',
      'relay_admission_selectors',
      'relay_assignment_activity_leases',
      'relay_assignment_migration_incarnations',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments',
      'relay_audit_events',
      'relay_cell_admission',
      'relay_cell_capabilities',
      'relay_cell_committed_fences',
      'relay_cell_connection_limits',
      'relay_cell_connection_runtime',
      'relay_cell_connection_snapshots',
      'relay_cell_drain_attempt_states',
      'relay_cell_drain_attempts',
      'relay_cell_drain_recovery_attempts',
      'relay_cell_fence_apply_invocations',
      'relay_cell_fence_attempts',
      'relay_cell_fence_plan_bindings',
      'relay_cell_fences',
      'relay_cell_legacy_fence_adoptions',
      'relay_cell_regions',
      'relay_cell_rehome_safety',
      'relay_cell_runtime',
      'relay_cells',
      'relay_confirm_results',
      'relay_confirmable_splices',
      'relay_connection_bases',
      'relay_control_connection_reservations',
      'relay_devices',
      'relay_direct_authorizations',
      'relay_install_results',
      'relay_invites',
      'relay_migration_leases',
      'relay_post_drain_migration_pins',
      'relay_rate_windows',
      'relay_region_rehome_attempts',
      'relay_region_rehome_control',
      'relay_region_rehome_worker_state'
    ])
    await database.close()
  })

  it('rolls back every effect and serializes concurrent transactions', async () => {
    const database = await openInMemoryRelayDatabase()
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO relay_rate_windows
           (scope_key, window_kind, window_started_at, count) VALUES (?, ?, ?, ?)`,
          ['scope', 'invite', 1, 1]
        )
        throw new Error('injected failure')
      })
    ).rejects.toThrow('injected failure')
    expect(await database.query(`SELECT * FROM relay_rate_windows`)).toEqual([])

    await Promise.all([
      database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO relay_rate_windows
           (scope_key, window_kind, window_started_at, count) VALUES (?, ?, ?, ?)`,
          ['scope', 'invite', 1, 1]
        )
      }),
      database.transaction(async (transaction) => {
        const rows = await transaction.query(
          `SELECT count FROM relay_rate_windows
           WHERE scope_key = ? AND window_kind = ? AND window_started_at = ?`,
          ['scope', 'invite', 1]
        )
        await transaction.query(
          `UPDATE relay_rate_windows SET count = ?
           WHERE scope_key = ? AND window_kind = ? AND window_started_at = ?`,
          [Number(rows[0]?.count ?? 0) + 1, 'scope', 'invite', 1]
        )
      })
    ])
    const rows = await database.query(`SELECT count FROM relay_rate_windows`)
    expect(Number(rows[0]?.count)).toBe(2)
    await database.close()
  })

  it('persists SQLite state across process-style reopen', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-db-'))
    temporaryDirectories.push(dataDir)
    const first = await openRelayDatabase({ dataDir })
    await first.query(
      `INSERT INTO relay_rate_windows
       (scope_key, window_kind, window_started_at, count) VALUES (?, ?, ?, ?)`,
      ['scope', 'connect', 1, 7]
    )
    await first.close()
    const second = await openRelayDatabase({ dataDir })
    const rows = await second.query(`SELECT count FROM relay_rate_windows`)
    expect(Number(rows[0]?.count)).toBe(7)
    await second.close()
  })

  it('defaults cells created by an older schema user to the US on reopen', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-region-db-'))
    temporaryDirectories.push(dataDir)
    const first = await openRelayDatabase({ dataDir })
    await first.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES (?, ?, 1, 10, 0, 0, 1, 1)`,
      ['legacy-cell', 'https://legacy.relay.example.com']
    )
    await first.close()

    const second = await openRelayDatabase({ dataDir })
    expect(
      await second.query(`SELECT region FROM relay_cell_regions WHERE cell_id = ?`, [
        'legacy-cell'
      ])
    ).toEqual([{ region: 'us-central1' }])
    await second.close()
  })

  it('indexes region preference expiry by observation time', async () => {
    const database = await openInMemoryRelayDatabase()
    const rows = await database.query(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'relay_assignment_region_preferences_observed'`
    )
    expect(rows[0]?.sql).toContain('(observed_at)')
    await database.close()
  })
})
