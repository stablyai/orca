import type Database from '../../sqlite/sync-database'
import type { LegacySourceArtifact } from './journal-legacy-retention-error'

/** Both shapes, not only the one that refused: a journal can carry both. */
export function legacySourceArtifacts(
  db: Database.Database,
  tables: ReadonlySet<string>
): LegacySourceArtifact {
  const pauses = tables.has('queued_message_pauses')
  const sourceJson =
    tables.has('queued_messages') &&
    db
      .prepare('PRAGMA table_info(queued_messages)')
      .all()
      .some((column) => column.name === 'source_json')
  return pauses && sourceJson
    ? 'both'
    : pauses
      ? 'pause_table'
      : sourceJson
        ? 'source_json'
        : 'none'
}
