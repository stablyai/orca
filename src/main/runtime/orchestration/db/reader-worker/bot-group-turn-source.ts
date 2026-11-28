import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { BotGroupTurnSchema } from '../../../../../shared/bots/bot-group-schema'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from '../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
import { agentJournalItemForWire } from '../../../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import type Database from '../../../../sqlite/sync-database'
import type { BotGroupTurnSource, BotGroupTurnSourceInput } from './orchestration-reader-protocol'

const turnHeader = BotGroupTurnSchema.pick({ sessionId: true, turnItemId: true })
const initialized = new WeakSet<Database>()
const archiveUse = new WeakMap<Database, Map<string, number>>()
const PAGE_ROWS = 128
const PAGE_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES - PAGE_ROWS * 2
// Match the room's concurrent detail-read cap: retain interleaved open turns without keeping every
// archive a reader has ever opened.
const MAX_ARCHIVED_TURNS = 8

const MATCHING_TURN = `FROM bot_group_messages m, json_each(m.record, '$.turns') turn
  WHERE m.id=? AND m.group_id=? AND json_extract(m.record, '$.threadId') IS ?
  AND json_extract(turn.value, '$.operationId')=?`

function prepareArchive(db: Database): void {
  if (!initialized.has(db)) {
    // The reader's temporary SQLite index lasts with its connection. No decoded archives accumulate in JS.
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS bot_group_archive_turn (
      operation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, thread_id TEXT, source_version INTEGER NOT NULL);
      CREATE TEMP TABLE IF NOT EXISTS bot_group_archive_item (
      operation_id TEXT NOT NULL, position INTEGER NOT NULL, record TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(operation_id, position));`)
    initialized.add(db)
  }
}

function dropArchive(db: Database, operationId: string): void {
  db.prepare('DELETE FROM bot_group_archive_item WHERE operation_id=?').run(operationId)
  db.prepare('DELETE FROM bot_group_archive_turn WHERE operation_id=?').run(operationId)
  archiveUse.get(db)?.delete(operationId)
}

function retainArchive(db: Database, operationId: string): void {
  let used = archiveUse.get(db)
  if (!used) {
    used = new Map()
    archiveUse.set(db, used)
  }
  used.delete(operationId)
  while (used.size >= MAX_ARCHIVED_TURNS) {
    const oldest = used.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    dropArchive(db, oldest)
  }
  used.set(operationId, Date.now())
}

/** The reader projects old frozen arrays once into a seekable archive owned by its connection. */
export function readBotGroupTurnSource(
  db: Database,
  input: BotGroupTurnSourceInput
): BotGroupTurnSource {
  const { operationId, messageId, groupId, threadId, version, before } = input
  prepareArchive(db)
  const indexed = db
    .prepare(`SELECT 1 FROM bot_group_archive_turn
    WHERE operation_id=? AND group_id=? AND thread_id IS ? AND source_version=?`)
    .get(operationId, groupId, threadId ?? null, version)
  if (indexed) {
    retainArchive(db, operationId)
    return { kind: 'frozen', page: readFrozenPage(db, operationId, before) }
  }
  const scope = [messageId, groupId, threadId ?? null, operationId] as const
  const source = db
    .prepare(`SELECT json_remove(turn.value,'$.frozenItems') AS header,
    json_type(turn.value,'$.frozenItems')='array' AS frozen ${MATCHING_TURN} LIMIT 1`)
    .get(...scope)
  if (!source) {
    dropArchive(db, operationId)
    return null
  }
  if (!source.frozen) {
    dropArchive(db, operationId)
    const { sessionId, turnItemId } = turnHeader.parse(JSON.parse(String(source.header)))
    return { kind: 'journal', sessionId, turnItemId }
  }

  dropArchive(db, operationId)
  retainArchive(db, operationId)
  db.prepare(`INSERT INTO bot_group_archive_item(operation_id,position,record,bytes)
    SELECT ?, CAST(frozen.key AS INTEGER)+1, frozen.value, octet_length(frozen.value)+1
    FROM (
      SELECT turn.value AS body ${MATCHING_TURN} LIMIT 1
    ) selected, json_each(selected.body,'$.frozenItems') frozen`).run(operationId, ...scope)
  db.prepare('INSERT OR REPLACE INTO bot_group_archive_turn VALUES (?,?,?,?)').run(
    operationId,
    groupId,
    threadId ?? null,
    version
  )
  return { kind: 'frozen', page: readFrozenPage(db, operationId, before) }
}

function readFrozenPage(
  db: Database,
  operationId: string,
  before = Number.MAX_SAFE_INTEGER
): BotGroupTurnDetailPage {
  const headers = db
    .prepare(`SELECT position,bytes FROM bot_group_archive_item
    WHERE operation_id=? AND position<? ORDER BY position DESC LIMIT ?`)
    .all(operationId, before, PAGE_ROWS)
  let remaining = PAGE_BYTES
  const positions: number[] = []
  let oversized: AgentJournalRenderItem | undefined
  for (const header of headers) {
    const bytes = Number(header.bytes)
    const position = Number(header.position)
    if (bytes > remaining) {
      if (positions.length === 0) {
        const row = db
          .prepare(`SELECT json_remove(record,'$.body') AS record
          FROM bot_group_archive_item WHERE operation_id=? AND position=?`)
          .get(operationId, position)
        oversized = row ? oversizedHistoryItem(JSON.parse(String(row.record))) : undefined
        positions.push(position)
      }
      break
    }
    positions.push(position)
    remaining -= bytes
  }
  const items = oversized
    ? [oversized]
    : db
        .prepare(`SELECT record FROM bot_group_archive_item
        WHERE operation_id=? AND position IN (SELECT value FROM json_each(?)) ORDER BY position`)
        .all(operationId, JSON.stringify(positions))
        .map((row) => agentJournalItemForWire(JSON.parse(String(row.record))).item)
  const next = positions.at(-1) ?? 0
  return { items, ...(next > 1 ? { before: { journal: [next, 0, 0] } } : {}) }
}
