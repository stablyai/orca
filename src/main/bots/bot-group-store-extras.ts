import type * as z from 'zod'
import { BotGroupMessageSchema, BotGroupSchema } from '../../shared/bots/bot-group-schema'
import type Database from '../sqlite/sync-database'

/**
 * A build's store parses a record with its own schema and writes the whole record back, so it
 * drops every field it predates. The fields that came after the build without paired-computer
 * members are therefore kept beside the record, where no older build writes: its edit or new
 * thread keeps the paired roster, remote answers and peer answers. A newer build's fields land
 * beside the record the same way, and this build writes them back as they were stored.
 */
type Raw = Record<string, unknown>
type RecordExtras = { record?: Raw; turns?: Record<string, Raw> }

export const BOT_GROUP_EXTRAS_TABLES = `CREATE TABLE IF NOT EXISTS bot_group_extras (group_id TEXT PRIMARY KEY, extras TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bot_group_message_extras (message_id TEXT PRIMARY KEY, extras TEXT NOT NULL);`

/** The column a group or message row selects what is kept beside it with. */
export const GROUP_EXTRAS =
  '(SELECT extras FROM bot_group_extras WHERE group_id = bot_groups.id) AS extras'
export const MESSAGE_EXTRAS =
  '(SELECT extras FROM bot_group_message_extras WHERE message_id = bot_group_messages.id) AS extras'

const TABLES = {
  group: { table: 'bot_group_extras', key: 'group_id' },
  message: { table: 'bot_group_message_extras', key: 'message_id' }
} as const

/** Each record's fields from after that build; it reads and writes every other one. */
const GROUP = level(BotGroupSchema.shape, ['remoteMembers'])
const MESSAGE = level(BotGroupMessageSchema.shape, ['remoteAsks'])
const TURN = level(BotGroupMessageSchema.shape.turns.element.shape, ['answer'])

function level(shape: Record<string, z.ZodType>, later: readonly string[]) {
  return { shape, base: new Set(Object.keys(shape).filter((key) => !later.includes(key))) }
}

/** A selected row's record, with what was kept beside it read over what an older build wrote. */
export function rowRecord(row: Raw): Raw {
  const record: Raw = JSON.parse(String(row.record))
  const extras: RecordExtras = typeof row.extras === 'string' ? JSON.parse(row.extras) : {}
  const { turns } = record
  return {
    ...record,
    ...extras.record,
    ...(Array.isArray(turns) && {
      turns: turns.map((turn: Raw) => ({ ...turn, ...extras.turns?.[String(turn.operationId)] }))
    })
  }
}

type StoredMessage = Raw & { id: string; groupId: string; turns: readonly Raw[] }

/** A post's split, with each turn's later fields kept by its operation id. */
function splitMessage(message: StoredMessage, kept: RecordExtras | null) {
  const turns: Record<string, Raw> = {}
  const [record, extras] = split(MESSAGE, message, kept?.record)
  record.turns = message.turns.map((turn) => {
    const id = String(turn.operationId)
    const [base, later] = split(TURN, turn, kept?.turns?.[id])
    if (later) {
      turns[id] = later
    }
    return base
  })
  const hasTurns = Object.keys(turns).length > 0
  const both = { ...(extras && { record: extras }), ...(hasTurns && { turns }) }
  return { record, extras: extras || hasTurns ? both : null }
}

/** The fields every build reads, and the later ones. A later field keeps what was stored beside
 *  the record when this build can't read it, or reads it unchanged. */
function split(
  { shape, base }: ReturnType<typeof level>,
  next: Raw,
  kept: Raw | undefined
): [Raw, Raw | null] {
  const record: Raw = {}
  const extras: Raw = {}
  for (const [key, value] of Object.entries(next)) {
    if (base.has(key)) {
      record[key] = value
    } else if (value !== undefined) {
      extras[key] = value
    }
  }
  for (const [key, value] of Object.entries(kept ?? {})) {
    const schema = shape[key]
    if (!base.has(key) && (!schema || same(schema, value, next[key]))) {
      extras[key] = value
    }
  }
  return [record, Object.keys(extras).length > 0 ? extras : null]
}

function same(schema: z.ZodType, stored: unknown, next: unknown): boolean {
  const read = (value: unknown) => JSON.stringify(schema.safeParse(value).data)
  return read(stored) === read(next === undefined ? undefined : JSON.parse(JSON.stringify(next)))
}

/** Writes group and post records, each with its later fields beside it. Call inside a transaction. */
export class BotGroupRecordWrites {
  constructor(private readonly db: Database) {}

  putGroup(group: Raw & { id: string }): void {
    const kept = this.stored('group', group.id)
    const [record, extras] = split(GROUP, group, kept?.record)
    this.db
      .prepare(
        'INSERT INTO bot_groups(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record'
      )
      .run(group.id, JSON.stringify(record))
    this.save('group', group.id, extras && { record: extras }, kept !== null)
  }

  insertMessage(message: StoredMessage): void {
    const { record, extras } = splitMessage(message, null)
    this.db
      .prepare('INSERT INTO bot_group_messages(id, group_id, record) VALUES (?, ?, ?)')
      .run(message.id, message.groupId, JSON.stringify(record))
    this.save('message', message.id, extras, false)
  }

  updateMessage(message: StoredMessage): void {
    const kept = this.stored('message', message.id)
    const { record, extras } = splitMessage(message, kept)
    const result = this.db
      .prepare('UPDATE bot_group_messages SET record = ? WHERE id = ? AND group_id = ?')
      .run(JSON.stringify(record), message.id, message.groupId)
    if (Number(result.changes) > 0) {
      this.save('message', message.id, extras, kept !== null)
    }
  }

  private stored(kind: keyof typeof TABLES, id: string): RecordExtras | null {
    const { table, key } = TABLES[kind]
    const row = this.db.prepare(`SELECT extras FROM ${table} WHERE ${key} = ?`).get(id)
    return row ? JSON.parse(String(row.extras)) : null
  }

  /** `had`: a row is stored beside this record, which no fields left now removes. */
  private save(kind: keyof typeof TABLES, id: string, extras: RecordExtras | null, had: boolean) {
    const { table, key } = TABLES[kind]
    if (!extras) {
      if (had) {
        this.db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(id)
      }
      return
    }
    this.db
      .prepare(
        `INSERT INTO ${table}(${key}, extras) VALUES (?, ?) ON CONFLICT(${key}) DO UPDATE SET extras = excluded.extras`
      )
      .run(id, JSON.stringify(extras))
  }
}
