import type { CommandReceiptRead } from './command-receipt-table'

import type { SqliteRow } from '../../sqlite/sqlite-statement'

import type Database from '../../sqlite/sync-database'

import { JOURNAL_NEWEST_OUTCOME_SQL } from './journal-outcome-persistence'
import { journalOutcomeSource } from './journal-outcome-format'
import { readCommandReceipt } from './command-receipt-table'

import type { JournalRead, JournalReadResult } from './journal-sql-protocol'

export class JournalNativeReads {
  private readonly pages = new Map<number, Iterator<SqliteRow>>()
  private nextPage = 0
  private page(token: number): JournalReadResult {
    const iterator = this.pages.get(token)
    if (!iterator) {
      throw new Error('journal read page is closed')
    }
    const rows: SqliteRow[] = []
    let bytes = 0
    while (rows.length < 128 && bytes < 256 * 1024) {
      const next = iterator.next()
      if (next.done) {
        this.pages.delete(token)
        return { kind: 'rows', rows }
      }
      rows.push(next.value)
      for (const [key, value] of Object.entries(next.value)) {
        bytes +=
          Buffer.byteLength(key) +
          (typeof value === 'string'
            ? Buffer.byteLength(value)
            : value instanceof Uint8Array
              ? value.byteLength
              : 8)
      }
    }
    return { kind: 'rows', rows, token }
  }
  read(database: Database.Database, query: JournalRead): JournalReadResult {
    switch (query.kind) {
      case 'sql': {
        const statement = database.prepare(query.sql)
        if (query.one) {
          const row = statement.get(...query.parameters)
          return { kind: 'rows', rows: row ? [row] : [] }
        }
        const token = ++this.nextPage
        this.pages.set(token, statement.iterate(...query.parameters))
        return this.page(token)
      }
      case 'page':
        return this.page(query.token)
      case 'release':
        this.pages.get(query.token)?.return?.()
        this.pages.delete(query.token)
        return { kind: 'rows', rows: [] }
      case 'outcomes': {
        const statement = database.prepare(JOURNAL_NEWEST_OUTCOME_SQL)
        const rows: SqliteRow[] = []
        let field = query.field,
          key = query.key,
          bytes = 0
        while (rows.length < 128 && bytes < 256 * 1024) {
          const row = statement.get(query.generation, field, key, query.through)
          if (!row) {
            break
          }
          if (typeof row.field !== 'string' || typeof row.entry_key !== 'string') {
            throw new Error('invalid journal outcome key')
          }
          rows.push(row)
          bytes += typeof row.value_json === 'string' ? Buffer.byteLength(row.value_json) : 0
          field = row.field
          key = row.entry_key
        }
        return { kind: 'rows', rows }
      }
      case 'source':
        return {
          kind: 'source',
          source: journalOutcomeSource(database, query.sessionId, query.epoch)
        }
      case 'receipts': {
        const receipts: CommandReceiptRead[] = []
        let bytes = 0
        for (const id of query.ids) {
          const receipt = readCommandReceipt(database, query.scope, id)
          const size = Buffer.byteLength(JSON.stringify(receipt))
          if (receipts.length > 0 && bytes + size > 256 * 1024) {
            break
          }
          receipts.push(receipt)
          bytes += size
          if (bytes >= 256 * 1024) {
            break
          }
        }
        return { kind: 'receipts', receipts }
      }
      case 'probe': {
        const tables = new Set(
          database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => row.name)
        )
        return {
          kind: 'probe',
          present: ['agent_session_records', 'agent_session_tabs'].some(
            (name) =>
              tables.has(name) &&
              database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get() !== undefined
          )
        }
      }
    }
  }
  close(): void {
    for (const iterator of this.pages.values()) {
      iterator.return?.()
    }
    this.pages.clear()
  }
}
