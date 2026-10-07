/** Merging migrated rows by id: a new id is added, a known id must carry the identical row. */
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'

export function selectNewRows<T extends { id: string }>(
  incoming: T[],
  existing: T[],
  conflictError: (id: string) => string
): T[] {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  return incoming.filter((row) => {
    const current = existingById.get(row.id)
    if (!current) {
      return true
    }
    if (serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(row)) {
      throw new Error(conflictError(row.id))
    }
    return false
  })
}

export function assertSameValue(left: unknown, right: unknown, label: string): void {
  if (serializeOrcadMigrationValue(left) !== serializeOrcadMigrationValue(right)) {
    throw new Error(`orcad_migration_dormant_id_conflict:${label}`)
  }
}
