// Which worker a bot's conversation handed its code work to: links only, never the work's state,
// which is read live from orchestration. SQLite holds the one-live-row-per-address rule. Runs only in
// the bots DB worker; the main side reaches it through bot-work-ops.ts.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import type { ConnectorSource } from '../../shared/connectors/external-conversation-link'
import { ADDED_COLUMNS, BOT_WORK_SCHEMA, rowOf, type BotWorkCloseReason } from './bot-work-rows'

/** A connector conversation the work came from: a Slack thread, a Linear issue, a GitHub thread. */
export type BotConversationAddress = { source: ConnectorSource; externalId: string }

/** One of the bot's own chats in Orca, by its session id: it has no reply address. */
export type BotChatAddress = { source: 'chat'; externalId: string }

/** Where the work came from: a connector conversation, or one of the bot's chats. */
export type BotWorkAddress = BotConversationAddress | BotChatAddress

/** A row as it was read; a close or flag names its generation so a later row is never touched. */
export type BotWorkRef = { rowId: string; generation: number }

/** 'local', or the paired server's environment id. */
export type BotWorkHost = string

export { BOT_WORK_CLOSE_REASONS, type BotWorkCloseReason } from './bot-work-rows'

export type BotWorkRow = BotWorkRef & {
  botId: string
  address: BotWorkAddress
  taskId: string
  /** The Dispatch the bot's turn started; follow-ups extend its lineage. */
  dispatchId: string
  host: BotWorkHost
  /** The thread's default for follow-ups; a superseded row stays live for its work's links. */
  current: boolean
  /** The turn that started it was asked in Orca, not through the conversation's connector. */
  askedInApp: boolean
  createdAt: number
  closedAt: number | null
  closeReason: BotWorkCloseReason | null
}

export type BotWorkBind = {
  botId: string
  address: BotWorkAddress
  taskId: string
  dispatchId: string
  host: BotWorkHost
  askedInApp?: boolean
}

export class BotWorkStore {
  private constructor(private readonly db: SyncDatabase) {}

  /** Releases the database file, so its folder can be removed (Windows refuses while it is open). */
  dispose(): void {
    this.db.close()
  }

  static open(path: string): BotWorkStore {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    const db = new SyncDatabase(path)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    // A file an earlier build wrote: add its missing columns ahead of the indexes that read them.
    const columns = db.prepare("SELECT name FROM pragma_table_info('bot_work')").all()
    if (columns.length > 0) {
      for (const [name, type] of ADDED_COLUMNS) {
        if (!columns.some((column) => column.name === name)) {
          db.exec(`ALTER TABLE bot_work ADD COLUMN ${name} ${type}`)
        }
      }
    }
    db.exec(BOT_WORK_SCHEMA)
    hardenSqliteDatabaseFiles(path)
    return new BotWorkStore(db)
  }

  private rows(where: string, ...params: (string | number)[]): BotWorkRow[] {
    return this.db
      .prepare(`SELECT * FROM bot_work WHERE ${where} ORDER BY created_at DESC, generation DESC`)
      .all(...params)
      .flatMap((row) => rowOf(row) ?? [])
  }

  /** The address's current row: where its thread's follow-ups go. */
  live(botId: string, address: BotWorkAddress): BotWorkRow | null {
    return this.addressRows(botId, address).find((row) => row.current) ?? null
  }

  /** The address's live rows: its current one and the superseded ones still live. */
  addressRows(botId: string, address: BotWorkAddress): BotWorkRow[] {
    return this.rows(
      'bot_id = ? AND source = ? AND external_id = ? AND closed_at IS NULL',
      botId,
      address.source,
      address.externalId
    )
  }

  /** Every live row, current or superseded, or one bot's. */
  liveRows(botId?: string): BotWorkRow[] {
    return botId
      ? this.rows('bot_id = ? AND closed_at IS NULL', botId)
      : this.rows('closed_at IS NULL')
  }

  /** Still live, as this generation. */
  isOpen(ref: BotWorkRef): boolean {
    return (
      this.rows('id = ? AND generation = ? AND closed_at IS NULL', ref.rowId, ref.generation)
        .length > 0
    )
  }

  /** A new generation for this address as its current row, unless one is: storage refuses a second. */
  bind(input: BotWorkBind, now = Date.now()): BotWorkRow | null {
    const { botId, address } = input
    const id = randomUUID()
    const inserted = this.db
      .prepare(
        `INSERT INTO bot_work (id, bot_id, source, external_id, generation, task_id, dispatch_id, host,
           asked_in_app, current, created_at)
         SELECT ?, ?, ?, ?, COALESCE(MAX(generation), 0) + 1, ?, ?, ?, ?, 1, ?
           FROM bot_work WHERE bot_id = ? AND source = ? AND external_id = ?
         ON CONFLICT DO NOTHING`
      )
      .run(
        id,
        botId,
        address.source,
        address.externalId,
        input.taskId,
        input.dispatchId,
        input.host,
        input.askedInApp ? 1 : 0,
        now,
        botId,
        address.source,
        address.externalId
      )
    return inserted.changes > 0 ? this.rows('id = ?', id)[0] : null
  }

  /** Compare-and-swap: false when the row was already closed or is another generation. */
  close(ref: BotWorkRef, reason: BotWorkCloseReason, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE bot_work SET closed_at = ?, close_reason = ?
            WHERE id = ? AND generation = ? AND closed_at IS NULL`
        )
        .run(now, reason, ref.rowId, ref.generation).changes > 0
    )
  }

  /** The current row steps aside, still live, and the next generation becomes current, in one
   *  transaction. */
  replace(ref: BotWorkRef, input: BotWorkBind, now = Date.now()): BotWorkRow | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const demoted =
        this.db
          .prepare(
            `UPDATE bot_work SET current = 0
              WHERE id = ? AND generation = ? AND closed_at IS NULL AND current = 1`
          )
          .run(ref.rowId, ref.generation).changes > 0
      const row = demoted ? this.bind(input, now) : null
      this.db.exec(row ? 'COMMIT' : 'ROLLBACK')
      return row
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
