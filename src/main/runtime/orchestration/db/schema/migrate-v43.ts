import type { OrchestrationDb } from '../orchestration-db'

// Frozen literals, never the live prefix constant: a migration rewrites what that build wrote.
const LEGACY_PREFIX = 'session:'
const CURRENT_PREFIX = 'orca_session_id:'

// Rewrite address columns only; bodies, subjects and payload text retain their original content.
const ADDRESS_COLUMNS = [
  ['messages', 'from_handle'],
  ['messages', 'to_handle'],
  ['coordinator_runs', 'coordinator_handle']
] as const

// If both spellings exist for a keyed address, the legacy row is redundant.
const KEYED_ADDRESS_COLUMNS = [
  ['run_coordinator_handles', 'terminal_handle'],
  ['structured_pointer_operations', 'mailbox_handle']
] as const

/** Respell stored session: addresses as orca_session_id: so pre-upgrade mail, routing and replies remain reachable. */
export function migrateV43(this: OrchestrationDb, current: number): void {
  if (current >= 43) {
    return
  }
  const isLegacy = (column: string): string =>
    `substr(${column}, 1, ${LEGACY_PREFIX.length}) = '${LEGACY_PREFIX}'`
  const respelled = (column: string): string =>
    `'${CURRENT_PREFIX}' || substr(${column}, ${LEGACY_PREFIX.length + 1})`
  for (const [table, column] of ADDRESS_COLUMNS) {
    this.db.exec(`UPDATE ${table} SET ${column} = ${respelled(column)} WHERE ${isLegacy(column)}`)
  }
  for (const [table, column] of KEYED_ADDRESS_COLUMNS) {
    this.db.exec(`
      UPDATE OR IGNORE ${table} SET ${column} = ${respelled(column)} WHERE ${isLegacy(column)};
      DELETE FROM ${table} WHERE ${isLegacy(column)};
    `)
  }
}
