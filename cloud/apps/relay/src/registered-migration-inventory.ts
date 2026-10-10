import type { RelayDatabase, SqlRow } from './database.js'
import {
  ABANDONED_REGISTERED_MIGRATION,
  REGISTERED_MIGRATION_ABANDON_MS
} from './registered-migration-abandonment.js'

export type RegisteredMigrationInventory = {
  open: number
  inactive: number
  abandoned: number
  pairs: Array<{
    sourceCellId: string
    targetCellId: string
    open: number
    inactive: number
    abandoned: number
  }>
}

export async function readRegisteredMigrationInventory(
  database: RelayDatabase,
  now: number
): Promise<RegisteredMigrationInventory> {
  const abandonedBefore = now - REGISTERED_MIGRATION_ABANDON_MS
  const openRows = await database.query(
    `SELECT migration.source_cell_id, migration.target_cell_id, COUNT(*) AS open
     FROM relay_assignment_migrations migration
     WHERE migration.completed_at IS NULL AND migration.aborted_at IS NULL
     GROUP BY migration.source_cell_id, migration.target_cell_id
     ORDER BY migration.source_cell_id, migration.target_cell_id`
  )
  const inactiveRows = await database.query(
    `SELECT migration.source_cell_id, migration.target_cell_id,
            COUNT(*) AS inactive,
            COALESCE(SUM(CASE WHEN ${ABANDONED_REGISTERED_MIGRATION}
                              THEN 1 ELSE 0 END), 0) AS abandoned
     FROM relay_assignment_migrations migration
     WHERE migration.target_registered_at IS NOT NULL
       AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
       AND migration.expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM relay_assignment_activity_leases target_control
         WHERE target_control.user_id = migration.user_id
           AND target_control.relay_host_id = migration.relay_host_id
           AND target_control.cell_id = migration.target_cell_id
           AND target_control.activity_kind = 'control'
           AND target_control.activity_id NOT LIKE 'control-pending:%'
       )
     GROUP BY migration.source_cell_id, migration.target_cell_id
     ORDER BY migration.source_cell_id, migration.target_cell_id`,
    [now, abandonedBefore, abandonedBefore, now]
  )
  const inactiveByPair = new Map(
    inactiveRows.map((row) => [
      JSON.stringify([text(row, 'source_cell_id'), text(row, 'target_cell_id')]),
      row
    ])
  )
  const pairs = openRows.map((row) => {
    const sourceCellId = text(row, 'source_cell_id')
    const targetCellId = text(row, 'target_cell_id')
    const inactive = inactiveByPair.get(JSON.stringify([sourceCellId, targetCellId]))
    return {
      sourceCellId,
      targetCellId,
      open: integer(row, 'open'),
      inactive: integer(inactive, 'inactive'),
      abandoned: integer(inactive, 'abandoned')
    }
  })
  return {
    open: pairs.reduce((total, pair) => total + pair.open, 0),
    inactive: pairs.reduce((total, pair) => total + pair.inactive, 0),
    abandoned: pairs.reduce((total, pair) => total + pair.abandoned, 0),
    pairs
  }
}

export function formatRegisteredMigrationInventory(
  inventory: RegisteredMigrationInventory
): string[] {
  const lines = [
    `[orca-relay] migration inventory open=${inventory.open}` +
      ` expiredRegisteredInactive=${inventory.inactive}` +
      ` abandonedRegistered=${inventory.abandoned}`
  ]
  for (const pair of inventory.pairs) {
    lines.push(
      `[orca-relay] migration pair sourceCellId=${pair.sourceCellId}` +
        ` targetCellId=${pair.targetCellId} open=${pair.open}` +
        ` expiredRegisteredInactive=${pair.inactive}` +
        ` abandoned=${pair.abandoned}`
    )
  }
  return lines
}

function text(row: SqlRow | undefined, column: string): string {
  return String(row?.[column] ?? '')
}

function integer(row: SqlRow | undefined, column: string): number {
  return Number(row?.[column] ?? 0)
}
