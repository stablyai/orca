import { setImmediate } from 'node:timers/promises'
import Database from '../../../sqlite/sync-database'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import { isClaudeConversationEntry } from '../../../claude/transcripts/claude-conversation-fork-boundary'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import {
  createClaudeImportScratch,
  type ClaudeImportScratchOptions
} from './journal-claude-import-scratch'

type Row = Record<string, unknown>
type StoredPayload = { raw: string; lineIndex: number; position: number }

const SQLITE_FULL = 13
const BATCH_ROWS = 1024
const BATCH_BYTES = 16 * 1024 * 1024

// SQLite refuses pages past max_page_count with SQLITE_FULL; that is the quota or reserve.
function storageFailure(error: unknown): unknown {
  const errcode =
    error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_FULL
    ? new ClaudeImportResourceError('Claude history import scratch is full.', { cause: error })
    : error
}

function openScratch(options: ClaudeImportScratchOptions) {
  try {
    return createClaudeImportScratch(options)
  } catch (error) {
    if (error instanceof ClaudeImportResourceError) {
      throw error
    }
    throw new ClaudeImportResourceError('Claude history import scratch is unavailable.', {
      cause: error
    })
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function messageType(value: unknown): string | null {
  return value === 'user' || value === 'assistant' || value === 'attachment' || value === 'system'
    ? value
    : null
}

/** Disk-backed selection for a Claude transcript. Links are cheap; payloads are candidate-only. */
export function createClaudeImportGraph(options: ClaudeImportScratchOptions = {}) {
  const scratch = openScratch(options)
  let db: Database
  // Admit the next batch of writes only within the remaining quota and free-space reserve.
  const limitPages = () => {
    const pageSize = Number(db.pragma('page_size', { simple: true }))
    const pages = Number(db.pragma('page_count', { simple: true }))
    const allowance = Math.floor(scratch.grantBytes() / pageSize)
    if (allowance <= 0) {
      throw new ClaudeImportResourceError('Claude history import scratch is full.')
    }
    db.pragma(`max_page_count = ${pages + allowance}`)
  }
  const write = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      throw storageFailure(error)
    }
  }
  try {
    db = new Database(scratch.filename)
    scratch.attach(() => db.close())
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -4096;
      PRAGMA mmap_size = 0;
    `)
    // The schema's own pages come out of the first grant too.
    write(limitPages)
    db.exec(`
      CREATE TABLE rows (
        position INTEGER PRIMARY KEY, line_index INTEGER NOT NULL, uuid TEXT, parent_uuid TEXT,
        logical_parent_uuid TEXT, type TEXT, assistant_id TEXT, candidate INTEGER NOT NULL,
        raw_payload TEXT
      );
      CREATE INDEX rows_uuid ON rows(uuid, position DESC) WHERE uuid IS NOT NULL;
      CREATE INDEX rows_assistant ON rows(assistant_id, position) WHERE assistant_id IS NOT NULL;
      CREATE TABLE tool_uses (position INTEGER NOT NULL, tool_id TEXT NOT NULL, PRIMARY KEY(position, tool_id));
      CREATE TABLE tool_results (tool_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(tool_id, position));
      CREATE TABLE selected (seq INTEGER PRIMARY KEY, position INTEGER NOT NULL UNIQUE);
      CREATE TABLE expanded (assistant_id TEXT PRIMARY KEY, chunk INTEGER NOT NULL);
      CREATE INDEX expanded_chunk ON expanded(chunk);
    `)
  } catch (error) {
    scratch.close()
    throw storageFailure(error)
  }
  const insert = db.prepare(`INSERT INTO rows
    (position, line_index, uuid, parent_uuid, logical_parent_uuid, type, assistant_id, candidate, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertUse = db.prepare('INSERT OR IGNORE INTO tool_uses (position, tool_id) VALUES (?, ?)')
  const insertResult = db.prepare(
    'INSERT OR IGNORE INTO tool_results (tool_id, position) VALUES (?, ?)'
  )
  const latest = db.prepare(
    'SELECT position, parent_uuid, logical_parent_uuid FROM rows WHERE uuid = ? ORDER BY position DESC LIMIT 1'
  )
  const add = db.prepare('INSERT OR IGNORE INTO selected (position) VALUES (?)')
  const insertRow = (row: Row, position: number, lineIndex: number) => {
    const type = messageType(row.type)
    const candidate = isClaudeConversationEntry(row)
    const message = claudeRecord(row.message)
    const assistantId = type === 'assistant' ? text(message?.id) : null
    // Only message rows can become items; other records keep just their links.
    const payload = type ? JSON.stringify(row) : null
    insert.run(
      position,
      lineIndex,
      text(row.uuid),
      text(row.parentUuid),
      text(row.logicalParentUuid),
      type,
      assistantId,
      candidate ? 1 : 0,
      payload
    )
    if (Array.isArray(message?.content)) {
      for (const value of message.content) {
        const part = claudeRecord(value)
        const toolUseId = text(part?.id)
        const toolResultId = text(part?.tool_use_id)
        if (part?.type === 'tool_use' && toolUseId) {
          insertUse.run(position, toolUseId)
        }
        if (type === 'user' && part?.type === 'tool_result' && toolResultId) {
          insertResult.run(toolResultId, position)
        }
      }
    }
    return payload ? Buffer.byteLength(payload) : 0
  }
  let writes = 0
  let pendingBytes = 0
  // Autocommit costs a file write per statement; bounded transactions also bound each admission.
  const written = (bytes = 0) => {
    pendingBytes += bytes
    // A batch stays well inside one grant, even when its rows carry large payloads.
    if (++writes % BATCH_ROWS === 0 || pendingBytes >= BATCH_BYTES) {
      pendingBytes = 0
      write(() => {
        db.exec('COMMIT')
        limitPages()
        db.exec('BEGIN')
      })
    }
  }
  db.exec('BEGIN')

  return {
    record(row: Row, position: number, lineIndex: number) {
      if (row.isSidechain === true || row.parent_tool_use_id != null) {
        return
      }
      written(write(() => insertRow(row, position, lineIndex)))
    },
    async select(check: () => void): Promise<void> {
      // As the chain walker does, the tip is the newest conversation entry with an identity.
      const newest = db
        .prepare(
          'SELECT uuid FROM rows WHERE candidate = 1 AND uuid IS NOT NULL ORDER BY position DESC LIMIT 1'
        )
        .get()
      if (typeof newest?.uuid === 'string') {
        let uuid: string | null = newest.uuid
        for (let steps = 0; uuid !== null; steps += 1) {
          check()
          if (steps % 256 === 255) {
            await setImmediate()
          }
          const row = latest.get(uuid)
          if (!row || typeof row.position !== 'number') {
            break
          }
          const position = row.position
          // A selected ancestor means the parent links loop.
          if (write(() => add.run(position).changes) === 0) {
            break
          }
          written()
          uuid =
            typeof row.parent_uuid === 'string'
              ? row.parent_uuid
              : typeof row.logical_parent_uuid === 'string'
                ? row.logical_parent_uuid
                : null
        }
      }
      // Selection order is the work queue: each chunk adds assistant siblings and tool results,
      // which later chunks close in turn, as nested tool forks need.
      // Each assistant message expands once, as the walker deletes a group after using it.
      const expand = db.prepare(`INSERT OR IGNORE INTO expanded (assistant_id, chunk)
        SELECT DISTINCT r.assistant_id, ?3 FROM selected s JOIN rows r ON r.position = s.position
          WHERE s.seq > ?1 AND s.seq <= ?2 AND r.assistant_id IS NOT NULL`)
      const close = db.prepare(`INSERT OR IGNORE INTO selected (position)
        SELECT x.position FROM expanded e JOIN rows x ON x.assistant_id = e.assistant_id
          WHERE e.chunk = ?3
        UNION ALL
        SELECT t.position FROM selected s JOIN tool_uses u ON u.position = s.position
          JOIN tool_results t ON t.tool_id = u.tool_id
          WHERE s.seq > ?1 AND s.seq <= ?2`)
      const last = db.prepare('SELECT max(seq) AS seq FROM selected')
      for (let seq = 0, chunk = 0; ; chunk += 1) {
        check()
        const tail = last.get()?.seq
        if (typeof tail !== 'number' || seq >= tail) {
          break
        }
        // Rows this chunk adds get later sequence numbers, so a later chunk closes them.
        const from = seq
        const to = Math.min(seq + BATCH_ROWS, tail)
        seq = to
        write(() => {
          expand.run(from, to, chunk)
          close.run(from, to, chunk)
        })
        write(() => {
          db.exec('COMMIT')
          limitPages()
          db.exec('BEGIN')
        })
        await setImmediate()
      }
      // UUID-less message rows have no graph identity to walk; without a chain, system rows stay.
      const chained = typeof newest?.uuid === 'string'
      write(() =>
        db.exec(`INSERT OR IGNORE INTO selected (position) SELECT position FROM rows
          WHERE raw_payload IS NOT NULL AND (uuid IS NULL${chained ? '' : " OR type = 'system'"})`)
      )
      write(() => db.exec('COMMIT'))
    },
    /** Newest first, so the item budget stops decoding once it is full. */
    *payloads(): IterableIterator<StoredPayload> {
      const selected = db.prepare(`SELECT r.raw_payload, r.line_index, r.position FROM selected s
        JOIN rows r ON r.position = s.position WHERE r.raw_payload IS NOT NULL
        ORDER BY s.position DESC`)
      for (const row of selected.iterate()) {
        if (
          typeof row.raw_payload === 'string' &&
          typeof row.line_index === 'number' &&
          typeof row.position === 'number'
        ) {
          yield { raw: row.raw_payload, lineIndex: row.line_index, position: row.position }
        }
      }
    },
    close: () => scratch.close()
  }
}
