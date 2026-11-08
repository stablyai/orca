import type Database from '../../../sqlite/sync-database'
import {
  JOURNAL_DB_OLDEST_RELEASED_VERSION,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { journalPragmaNumber, runJournalTransaction } from './journal-database'
import { JournalUnreleasedSchemaError } from '../replay/journal-open-failure'
import { AgentSessionJournalError } from '../writing/journal-write-guards'

/** Only profile rows are copied; each chat's original transcript stays at its source. */
export function importJournalDomainProfile(
  source: Database.Database,
  destination: Database.Database
): void {
  const version = journalPragmaNumber(source, 'user_version')
  if (version > JOURNAL_DB_SCHEMA_VERSION) {
    throw new AgentSessionJournalError('journal_read_only', 'the original chat store is newer')
  }
  if (version < JOURNAL_DB_OLDEST_RELEASED_VERSION) {
    // An empty SQLite file can precede the first successful legacy initialization.
    if (version === 0 && !source.prepare("SELECT 1 FROM sqlite_schema WHERE type='table'").get()) {
      return
    }
    throw new JournalUnreleasedSchemaError(
      `the original chat store uses unreleased schema ${version}`
    )
  }
  copyProfileTable(source, destination, 'journal_sessions', ['session_id', 'workspace_id', 'epoch'])
  copyProfileTable(
    source,
    destination,
    'agent_session_records',
    ['session_id', 'record_json'],
    version < 4
  )
  copyProfileTable(
    source,
    destination,
    'agent_session_operations',
    ['operation_key', 'row_json'],
    version < 4
  )
  copyProfileTable(
    source,
    destination,
    'agent_session_retired_claim_keys',
    ['key_id', 'retired_at'],
    version < 4
  )
  copyProfileTable(
    source,
    destination,
    'agent_session_tabs',
    ['tab_id', 'session_id', 'position'],
    version < 4
  )
  copyProfileTable(source, destination, 'agent_session_store_meta', ['key', 'value'], version < 4)
  copyProfileTable(
    source,
    destination,
    'agent_session_command_receipts',
    [
      'operation_id',
      'session_id',
      'caller_key',
      'method',
      'fingerprint',
      'status',
      'result_json',
      'rejection_json',
      'accepted_at'
    ],
    true
  )
  copyProfileTable(
    source,
    destination,
    'agent_session_attachment_claims',
    ['upload_id', 'session_id', 'claimed_at'],
    true
  )
  copyProfileTable(
    source,
    destination,
    'agent_session_attachment_sweeps',
    ['upload_id', 'started_at'],
    true
  )
}

const PAGE_ROWS = 128
const PAGE_BYTES = 1024 * 1024

/** The fixed schema above is the whole copy surface; no JSON is interpreted or rewritten. */
function copyProfileTable(
  source: Database.Database,
  destination: Database.Database,
  table: string,
  columns: readonly string[],
  optional = false
): void {
  if (
    optional &&
    !source.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
  ) {
    return
  }
  const names = columns.join(',')
  const insert = destination.prepare(
    `INSERT INTO ${table}(rowid,${names}) VALUES(${columns.map(() => '?').join(',')},?)`
  )
  let after: bigint | undefined
  for (;;) {
    const page = source.prepare(`SELECT rowid,${names} FROM ${table}
      ${after === undefined ? '' : 'WHERE rowid>?'} ORDER BY rowid LIMIT ?`)
    page.setReadBigInts(true)
    const rows = page.all(...(after === undefined ? [] : [after]), PAGE_ROWS)
    if (rows.length === 0) {
      return
    }
    let first = 0
    while (first < rows.length) {
      let end = first
      let bytes = 0
      while (end < rows.length) {
        const row = rows[end]!
        const size = columns.reduce((total, column) => {
          const value = row[column]
          return (
            total +
            (value == null
              ? 0
              : typeof value === 'object'
                ? value.byteLength
                : Buffer.byteLength(String(value)))
          )
        }, 0)
        if (end > first && bytes + size > PAGE_BYTES) {
          break
        }
        bytes += size
        end++
      }
      runJournalTransaction(destination, () => {
        for (let index = first; index < end; index++) {
          const row = rows[index]!
          insert.run(row.rowid, ...columns.map((column) => row[column]!))
        }
      })
      first = end
    }
    after = BigInt(String(rows.at(-1)!.rowid))
  }
}
