import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import {
  projectAgentSessionConversationOutline,
  truncateOutlinePreview,
  type AgentSessionConversationOutlineEntry
} from '../../../shared/agent-session/agent-session-conversation-outline'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalOutlineMessage,
  journalOutlineStructure,
  type JournalOutlineSource
} from './journal-domain-outline-source'

type Target = { sessionId: string; epoch: string }
type SourceRow = { source: JournalOutlineSource; ordinal: number; structure: string }

function writeMember(
  db: Database.Database,
  target: Target,
  row: SourceRow,
  turnKey: string | undefined,
  entry: AgentSessionConversationOutlineEntry | undefined
): void {
  const json = entry ? JSON.stringify(entry) : null
  const short = entry
    ? JSON.stringify({ ...entry, preview: truncateOutlinePreview(entry.preview, 60) })
    : null
  const empty = entry ? JSON.stringify({ ...entry, preview: '' }) : null
  db.prepare(`INSERT INTO journal_outline_members(session_id,epoch,item_id,source_revision,
    sequence,sequence_index,ordinal,structure_json,turn_key,reply,entry_json,short_json,empty_json,
    entry_bytes,short_bytes,empty_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET
      source_revision=excluded.source_revision,sequence=excluded.sequence,sequence_index=excluded.sequence_index,
      ordinal=excluded.ordinal,structure_json=excluded.structure_json,turn_key=excluded.turn_key,
      reply=excluded.reply,entry_json=excluded.entry_json,short_json=excluded.short_json,empty_json=excluded.empty_json,
      entry_bytes=excluded.entry_bytes,short_bytes=excluded.short_bytes,empty_bytes=excluded.empty_bytes
    WHERE source_revision<>excluded.source_revision OR structure_json<>excluded.structure_json
      OR turn_key IS NOT excluded.turn_key OR reply IS NOT excluded.reply OR entry_json IS NOT excluded.entry_json`).run(
    target.sessionId,
    target.epoch,
    row.source.item.itemId,
    row.source.item.revision,
    row.source.item.sequence,
    row.source.item.sequenceIndex ?? 0,
    row.ordinal,
    row.structure,
    turnKey ?? null,
    row.source.reply,
    json,
    short,
    empty,
    json === null ? 0 : Buffer.byteLength(json, 'utf8') + 1,
    short === null ? 0 : Buffer.byteLength(short, 'utf8') + 1,
    empty === null ? 0 : Buffer.byteLength(empty, 'utf8') + 1
  )
}

function refreshReply(db: Database.Database, target: Target, key: string): void {
  const prefix = [target.sessionId, target.epoch, key] as const
  const row = db
    .prepare(`SELECT reply FROM journal_outline_members
    INDEXED BY journal_outline_reply_candidates WHERE session_id=? AND epoch=? AND turn_key=? AND reply IS NOT NULL
    ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
    .get(...prefix)
  if (!row) {
    db.prepare(
      'DELETE FROM journal_outline_replies WHERE session_id=? AND epoch=? AND turn_key=?'
    ).run(...prefix)
    return
  }
  const reply = String(row.reply)
  db.prepare(`INSERT INTO journal_outline_replies(session_id,epoch,turn_key,reply,reply_bytes) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,epoch,turn_key) DO UPDATE SET reply=excluded.reply,reply_bytes=excluded.reply_bytes
    WHERE reply<>excluded.reply`).run(
    ...prefix,
    reply,
    Buffer.byteLength(JSON.stringify({ reply }), 'utf8') - 1
  )
}

function sourceRow(row: SqliteRow): SourceRow {
  const source: JournalOutlineSource = JSON.parse(String(row.outline_source_json))
  return { source, ordinal: Number(row.ordinal), structure: journalOutlineStructure(source) }
}

/** Membership changes can refer backward through aliases/Stop; reproject compact facts, never originals. */
export function rebuildJournalDomainOutline(db: Database.Database, target: Target): void {
  const prefix = [target.sessionId, target.epoch] as const
  const sources = db
    .prepare(`SELECT ordinal,outline_source_json FROM journal_items
    INDEXED BY journal_items_visible_position WHERE session_id=? AND epoch=? AND hidden=0
    AND outline_source_json IS NOT NULL ORDER BY sequence,sequence_index,ordinal`)
    .all(...prefix)
    .map(sourceRow)
  const byId = new Map(sources.map((row) => [row.source.item.itemId, row]))
  const submissions = db
    .prepare(`SELECT outline_json FROM journal_submission_attempts
    INDEXED BY journal_submission_ordinal WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal`)
    .all(...prefix)
    .map((row): AgentJournalSubmission => JSON.parse(String(row.outline_json)))
  const turnKeys = new Map<string, string>()
  const entries = projectAgentSessionConversationOutline(
    sources.map((row) => row.source.item),
    submissions,
    (messages, keys) => {
      messages.forEach((message, index) => {
        const key = keys[index]
        if (key !== undefined) {
          turnKeys.set(message.id, key)
        }
      })
      return new Map()
    },
    {
      projectItems: (items) =>
        items.flatMap((item) => {
          const source = byId.get(item.itemId)?.source
          const message = source && journalOutlineMessage(source)
          return message ? [message] : []
        }),
      userPreview: (message) => byId.get(message.id)!.source.preview!
    }
  )
  const entriesById = new Map(entries.map((entry) => [entry.itemId, entry]))
  const old = db
    .prepare('SELECT item_id,turn_key FROM journal_outline_members WHERE session_id=? AND epoch=?')
    .all(...prefix)
  const affected = new Set<string>()
  const remove = db.prepare(
    'DELETE FROM journal_outline_members WHERE session_id=? AND epoch=? AND item_id=?'
  )
  for (const row of old) {
    if (row.turn_key !== null) {
      affected.add(String(row.turn_key))
    }
    if (!byId.has(String(row.item_id))) {
      remove.run(...prefix, String(row.item_id))
    }
  }
  for (const source of sources) {
    const key = turnKeys.get(source.source.item.itemId)
    if (key !== undefined) {
      affected.add(key)
    }
    writeMember(db, target, source, key, entriesById.get(source.source.item.itemId))
  }
  for (const key of affected) {
    refreshReply(db, target, key)
  }
}

/** Stable prose revisions replace one preview/candidate; only structural facts regroup membership. */
export function refreshJournalDomainOutline(
  db: Database.Database,
  target: Target,
  itemIds: readonly string[],
  submissionsChanged: boolean
): void {
  if (submissionsChanged) {
    rebuildJournalDomainOutline(db, target)
    return
  }
  const prefix = [target.sessionId, target.epoch] as const
  const current = db.prepare(`SELECT ordinal,outline_source_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND outline_source_json IS NOT NULL`)
  const member = db.prepare(`SELECT structure_json,turn_key,entry_json FROM journal_outline_members
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const updates: { row: SourceRow; old: SqliteRow }[] = []
  for (const id of new Set(itemIds)) {
    const saved = current.get(...prefix, id)
    const old = member.get(...prefix, id)
    if (!saved && !old) {
      continue
    }
    const row = saved && sourceRow(saved)
    if (!row || !old || row.structure !== old.structure_json) {
      rebuildJournalDomainOutline(db, target)
      return
    }
    updates.push({ row, old })
  }
  const affected = new Set<string>()
  for (const { row, old } of updates) {
    const key = old.turn_key === null ? undefined : String(old.turn_key)
    const preview = row.source.preview
    const entry =
      old.entry_json === null || preview === null
        ? undefined
        : {
            itemId: row.source.item.itemId,
            sequence: row.source.item.sequence,
            preview: preview.text,
            imageCount: preview.imageCount,
            ...(key === undefined || key === row.source.item.itemId ? {} : { turnKey: key })
          }
    writeMember(db, target, row, key, entry)
    if (key !== undefined) {
      affected.add(key)
    }
  }
  for (const key of affected) {
    refreshReply(db, target, key)
  }
}
