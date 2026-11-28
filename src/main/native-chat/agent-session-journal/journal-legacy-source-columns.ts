import { JOURNAL_DOMAIN_PROFILE_TABLES } from './database/journal-domain-profile-columns'

// Maps, not objects: a table named like an Object member (`constructor`) must find nothing.
const SOURCE_COLUMNS = new Map(
  Object.entries({
    journal_sessions: 'session_id workspace_id epoch',
    journal_rows: 'session_id epoch seq ts row_json',
    journal_outcome_generations: 'generation session_id epoch',
    journal_outcome_epochs: 'session_id epoch generation format through_seq prefix_seq',
    journal_outcomes: 'generation seq field entry_key format ordinal value_json deleted',
    journal_repairs: 'session_id epoch content_from repaired_at',
    journal_imports: 'session_id epoch tip',
    journal_set_aside: 'session_id epoch tip',
    queued_messages:
      'session_id message_id position body_json fingerprint created_at host_instance state hold_reason returned_reason returned_rejection settled_at settled_by_op consumed_as carried_from queued_epoch queued_sequence options_json'
  })
)
/**
 * Shapes earlier builds left in the original that no later build reads, accepted with exactly these
 * columns; SQLite keeps a column or table after the code that created it stops.
 * - queued_messages.source_json: hourly builds of 2026-10-05/06 (#25078, dropped by #25888).
 * - queued_message_pauses: v1.4.219's Stop pauses (#23726); #24072 stopped creating it.
 */
const RETIRED_SOURCE_COLUMNS = new Map([['queued_messages', 'source_json']])
const RETIRED_SOURCE_TABLES = new Map([
  ['queued_message_pauses', 'session_id reason epoch sequence recorded_at']
])
const PROFILE_COLUMNS = new Map(
  JOURNAL_DOMAIN_PROFILE_TABLES.map(({ name, columns }) => [name, new Set<string>(columns)])
)

/** A table only older builds created, whose rows no build reads. */
export function isRetiredSourceTable(table: string): boolean {
  return RETIRED_SOURCE_TABLES.has(table)
}

/** Every column of `table` is one some build wrote and this one accounts for; a retired table's exactly. */
export function legacySourceColumnsAccounted(table: string, present: readonly string[]): boolean {
  const retired = RETIRED_SOURCE_TABLES.get(table)?.split(' ')
  const source = SOURCE_COLUMNS.get(table)
  const columns =
    PROFILE_COLUMNS.get(table) ??
    (retired
      ? new Set(retired)
      : source
        ? new Set([...source.split(' '), ...(RETIRED_SOURCE_COLUMNS.get(table)?.split(' ') ?? [])])
        : undefined)
  return (
    !columns ||
    (present.every((name) => columns.has(name)) && (!retired || present.length === retired.length))
  )
}
