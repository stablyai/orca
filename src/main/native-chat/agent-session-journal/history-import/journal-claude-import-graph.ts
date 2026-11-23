import { setImmediate } from 'node:timers/promises'
import Database from '../../../sqlite/sync-database'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import { isClaudeConversationEntry } from '../../../claude/transcripts/claude-conversation-fork-boundary'

type Row = Record<string, unknown>
type StoredPayload = { raw: string; lineIndex: number; position: number }

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function messageType(value: unknown): string | null {
  return value === 'user' || value === 'assistant' || value === 'attachment' || value === 'system'
    ? value
    : null
}

/** Disk-backed selection for a Claude transcript. Links are cheap; payloads are candidate-only. */
export function createClaudeImportGraph() {
  const db = new Database('')
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -4096;
    PRAGMA mmap_size = 0;
    CREATE TABLE rows (
      position INTEGER PRIMARY KEY, line_index INTEGER NOT NULL, uuid TEXT, parent_uuid TEXT,
      logical_parent_uuid TEXT, type TEXT, assistant_id TEXT, candidate INTEGER NOT NULL,
      raw_payload TEXT
    );
    CREATE INDEX rows_uuid ON rows(uuid, position DESC) WHERE uuid IS NOT NULL;
    CREATE INDEX rows_assistant ON rows(assistant_id, position) WHERE assistant_id IS NOT NULL;
    CREATE TABLE tool_uses (tool_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(tool_id, position));
    CREATE TABLE tool_results (tool_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(tool_id, position));
    CREATE TABLE selected (position INTEGER PRIMARY KEY, processed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE walked_uuid (uuid TEXT PRIMARY KEY);
  `)
  const insert = db.prepare(`INSERT INTO rows
    (position, line_index, uuid, parent_uuid, logical_parent_uuid, type, assistant_id, candidate, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertUse = db.prepare('INSERT OR IGNORE INTO tool_uses (tool_id, position) VALUES (?, ?)')
  const insertResult = db.prepare('INSERT OR IGNORE INTO tool_results (tool_id, position) VALUES (?, ?)')
  const latest = db.prepare('SELECT position, parent_uuid, logical_parent_uuid FROM rows WHERE uuid = ? ORDER BY position DESC LIMIT 1')
  const add = db.prepare('INSERT OR IGNORE INTO selected (position) VALUES (?)')
  const seen = db.prepare('INSERT OR IGNORE INTO walked_uuid (uuid) VALUES (?)')
  let recorded = 0
  let closed = false
  db.exec('BEGIN')

  return {
    record(row: Row, position: number, lineIndex: number) {
      if (row.isSidechain === true || row.parent_tool_use_id != null) return
      const type = messageType(row.type)
      const candidate = isClaudeConversationEntry(row)
      const message = claudeRecord(row.message)
      const assistantId = type === 'assistant' ? text(message?.id) : null
      insert.run(
        position,
        lineIndex,
        text(row.uuid),
        text(row.parentUuid),
        text(row.logicalParentUuid),
        type,
        assistantId,
        candidate ? 1 : 0,
        candidate ? JSON.stringify(row) : null
      )
      if (Array.isArray(message?.content)) {
        for (const value of message.content) {
          const part = claudeRecord(value)
          if (part?.type === 'tool_use' && text(part.id)) insertUse.run(text(part.id), position)
          if (type === 'user' && part?.type === 'tool_result' && text(part.tool_use_id)) {
            insertResult.run(text(part.tool_use_id), position)
          }
        }
      }
      if (++recorded % 1024 === 0) db.exec('COMMIT; BEGIN')
    },
    async select(check: () => void): Promise<void> {
      db.exec('COMMIT')
      const newest = db.prepare('SELECT position, uuid FROM rows WHERE candidate = 1 ORDER BY position DESC LIMIT 1').get()
      if (typeof newest?.position === 'number') {
        let uuid = typeof newest.uuid === 'string' ? newest.uuid : null
        if (uuid === null) add.run(newest.position)
        for (let steps = 0; uuid !== null; steps += 1) {
          check()
          if (steps % 256 === 255) await setImmediate()
          if (seen.run(uuid).changes === 0) break
          const row = latest.get(uuid)
          if (!row || typeof row.position !== 'number') break
          add.run(row.position)
          uuid = typeof row.parent_uuid === 'string' ? row.parent_uuid : typeof row.logical_parent_uuid === 'string' ? row.logical_parent_uuid : null
        }
      }
      // Preserve UUID-less candidate rows; they have no graph identity to walk.
      db.exec('INSERT OR IGNORE INTO selected (position) SELECT position FROM rows WHERE candidate = 1 AND uuid IS NULL')
      const next = db.prepare(`SELECT s.position, r.type, r.assistant_id FROM selected s
        JOIN rows r ON r.position = s.position WHERE s.processed = 0 ORDER BY s.position LIMIT 1`)
      const mark = db.prepare('UPDATE selected SET processed = 1 WHERE position = ?')
      const siblings = db.prepare('SELECT position FROM rows WHERE assistant_id = ?')
      const results = db.prepare(`SELECT r.position FROM tool_uses u JOIN tool_results r ON r.tool_id = u.tool_id
        WHERE u.position = ?`)
      let count = 0
      for (;;) {
        check()
        const row = next.get()
        if (!row || typeof row.position !== 'number') break
        mark.run(row.position)
        if (typeof row.assistant_id === 'string') {
          for (const sibling of siblings.iterate(row.assistant_id)) if (typeof sibling.position === 'number') add.run(sibling.position)
        }
        for (const result of results.iterate(row.position)) if (typeof result.position === 'number') add.run(result.position)
        if (++count % 256 === 0) await setImmediate()
      }
    },
    *payloads(): IterableIterator<StoredPayload> {
      const selected = db.prepare(`SELECT r.raw_payload, r.line_index, r.position FROM selected s
        JOIN rows r ON r.position = s.position WHERE r.raw_payload IS NOT NULL ORDER BY r.position`)
      for (const row of selected.iterate()) {
        if (typeof row.raw_payload === 'string' && typeof row.line_index === 'number' && typeof row.position === 'number') {
          yield { raw: row.raw_payload, lineIndex: row.line_index, position: row.position }
        }
      }
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    }
  }
}
