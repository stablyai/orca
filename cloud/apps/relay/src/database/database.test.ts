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
  it('upgrades an existing SQLite relay without treating legacy controls as idle-capable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-idle-schema-'))
    temporaryDirectories.push(dataDir)
    const legacy = await openRelayDatabase({ dataDir })
    await legacy.query('ALTER TABLE relay_control_capabilities DROP COLUMN idle_regional_rehome')
    await legacy.query('ALTER TABLE relay_region_rehome_attempts DROP COLUMN source_generation')
    await legacy.query(
      `INSERT INTO relay_control_capabilities
       (user_id, relay_host_id, activity_id, cell_id, cell_incarnation, assignment_epoch, generation, finish_existing)
       VALUES ('legacy-user', 'abcdefghijklmnop', 'control:source:1', 'source', 'legacy-incarnation', 1, 1, 1)`
    )
    await legacy.close()
    const upgraded = await openRelayDatabase({ dataDir })
    try {
      expect(
        await upgraded.query('SELECT idle_regional_rehome FROM relay_control_capabilities')
      ).toEqual([{ idle_regional_rehome: 0 }])
      const columns = await upgraded.query(
        "SELECT * FROM pragma_table_info('relay_region_rehome_attempts')"
      )
      expect(columns.find((column) => column.name === 'source_generation')).toMatchObject({
        dflt_value: '0'
      })
    } finally {
      await upgraded.close()
    }
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
      await second.query(`SELECT region FROM relay_cell_regions WHERE cell_id = ?`, ['legacy-cell'])
    ).toEqual([{ region: 'us-central1' }])
    await second.close()
  })

})
