import { JOURNAL_DOMAIN_PROFILE_TABLES } from './journal-domain-profile-columns'
import { journalLegacyChatRevision, recordJournalLegacyChatRevision } from './journal-legacy-source'
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
  copyChatCatalog(source, destination)
  // The copy keeps rows as the original saved them, even a receipt whose chat record is gone.
  destination.pragma('foreign_keys = OFF')
  try {
    for (const { name, columns } of JOURNAL_DOMAIN_PROFILE_TABLES) {
      copyProfileTable(source, destination, name, columns)
    }
  } finally {
    destination.pragma('foreign_keys = ON')
  }
  // The baseline later launches compare with, so only chats an older Orca writes move.
  runJournalTransaction(destination, () => {
    for (const { session_id: id } of source
      .prepare('SELECT session_id FROM agent_session_records')
      .all()) {
      const revision = journalLegacyChatRevision(source, String(id)) ?? 'null'
      recordJournalLegacyChatRevision(destination, String(id), revision)
    }
  })
  if (source.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
    const highWater = source
      .prepare("SELECT seq FROM main.sqlite_sequence WHERE name='pr_check_events'")
      .get()
    if (highWater) {
      destination.prepare("DELETE FROM sqlite_sequence WHERE name='pr_check_events'").run()
      destination
        .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('pr_check_events',?)")
        .run(highWater.seq)
    }
  }
}

const PAGE_ROWS = 128

function copyChatCatalog(source: Database.Database, destination: Database.Database): void {
  const insert = destination.prepare(
    'INSERT INTO journal_chat_state(session_id,workspace_id) VALUES(?,?)'
  )
  runJournalTransaction(destination, () => {
    let after: string | undefined
    for (;;) {
      const rows = source
        .prepare(`SELECT session_id,workspace_id FROM journal_sessions
          ${after === undefined ? '' : 'WHERE session_id>?'} ORDER BY session_id LIMIT ?`)
        .all(...(after === undefined ? [] : [after]), PAGE_ROWS)
      if (rows.length === 0) {
        return
      }
      for (const row of rows) {
        insert.run(row.session_id, row.workspace_id)
      }
      after = String(rows.at(-1)!.session_id)
    }
  })
}

/** The fixed profile contract is the whole copy surface; no JSON is interpreted or rewritten. */
function copyProfileTable(
  source: Database.Database,
  destination: Database.Database,
  table: string,
  columns: readonly string[]
): void {
  const names = columns.join(',')
  const insert = destination.prepare(
    `INSERT INTO ${table}(rowid,${names}) VALUES(${columns.map(() => '?').join(',')},?)`
  )
  runJournalTransaction(destination, () => {
    let after: bigint | undefined
    for (;;) {
      // An INTEGER PRIMARY KEY column would otherwise rename the rowid result column.
      const page = source.prepare(`SELECT rowid AS rowid,${names} FROM ${table}
        ${after === undefined ? '' : 'WHERE rowid>?'} ORDER BY rowid LIMIT ?`)
      page.setReadBigInts(true)
      const rows = page.all(...(after === undefined ? [] : [after]), PAGE_ROWS)
      if (rows.length === 0) {
        return
      }
      for (const row of rows) {
        insert.run(row.rowid, ...columns.map((column) => row[column]!))
      }
      after = BigInt(String(rows.at(-1)!.rowid))
    }
  })
}
