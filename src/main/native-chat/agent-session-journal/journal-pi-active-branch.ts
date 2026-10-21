import { performance } from 'node:perf_hooks'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { asRecord, parseJsonObject, timestampMs } from '../../ai-vault/session-scanner-values'
import Database from '../../sqlite/sync-database'
import { decodeOmpTranscriptLine } from '../transcript-line-decoders-omp'

function closePiImportDatabase(db: Database.Database | null): void {
  try {
    db?.close()
  } catch (error) {
    console.warn('[journal-pi-import] temporary database close failed:', error)
  }
}

/** Keep the complete Pi tree on disk until its saved leaf identifies the active branch. */
export function createPiTranscriptCollector<T>(
  toItem: (message: NativeChatMessage, identity: AgentJournalItemIdentity) => T,
  identify: (line: string, lineIndex: number) => AgentJournalItemIdentity
): {
  record(line: string, fallbackId: string, lineIndex: number): void
  project(keep: (item: T) => void): Promise<void>
  close(): void
} {
  let db: Database.Database
  let opened: Database.Database | null = null
  let insert: Database.Statement
  let byFileIndex: Database.Statement
  try {
    opened = new Database('')
    db = opened
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -4096;
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        file_index INTEGER NOT NULL UNIQUE,
        parent_id TEXT,
        type TEXT,
        first_kept_id TEXT,
        raw_line TEXT NOT NULL,
        fallback_id TEXT NOT NULL,
        line_index INTEGER NOT NULL,
        branch_depth INTEGER
      );
      CREATE INDEX entries_branch_depth ON entries(branch_depth) WHERE branch_depth IS NOT NULL;
    `)
    insert = db.prepare(`INSERT INTO entries
      (id, file_index, parent_id, type, first_kept_id, raw_line, fallback_id, line_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    byFileIndex = db.prepare('SELECT id FROM entries WHERE file_index = ?')
    db.exec('BEGIN')
  } catch (error) {
    closePiImportDatabase(opened)
    throw error
  }
  let fileIndex = 0
  let version = 1
  let leafId: string | null = null
  let closed = false
  return {
    record(line, fallbackId, lineIndex) {
      const record = parseJsonObject(line)
      if (!record) {
        return
      }
      if (record.type === 'session') {
        version = typeof record.version === 'number' ? record.version : 1
        fileIndex += 1
        return
      }
      const id = version < 2 ? `#${fileIndex}` : record.id
      const parentId = version < 2 ? leafId : record.parentId
      if (typeof id !== 'string' || !(parentId === null || typeof parentId === 'string')) {
        throw new Error('Pi session entry has no valid branch identity')
      }
      // Pi v1 indexes include headers and parsed metadata, but not malformed lines.
      const keptByIndex =
        version < 2 && typeof record.firstKeptEntryIndex === 'number'
          ? byFileIndex.get(record.firstKeptEntryIndex)
          : undefined
      const firstKeptId =
        keptByIndex && typeof keptByIndex.id === 'string'
          ? keptByIndex.id
          : version < 2 && typeof record.firstKeptEntryIndex === 'number'
            ? null
            : record.firstKeptEntryId
      try {
        insert.run(
          id,
          fileIndex,
          parentId,
          typeof record.type === 'string' ? record.type : null,
          typeof firstKeptId === 'string' ? firstKeptId : null,
          line,
          fallbackId,
          lineIndex
        )
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed: entries.id')
        ) {
          throw new Error('Pi session has duplicate branch identities')
        }
        throw error
      }
      leafId = id
      fileIndex += 1
      if (fileIndex % 1024 === 0) {
        db.exec('COMMIT; BEGIN')
      }
    },
    async project(keep) {
      db.exec('COMMIT')
      if (leafId === null) {
        return
      }
      const byId = db.prepare(
        'SELECT parent_id, type, first_kept_id, branch_depth FROM entries WHERE id = ?'
      )
      const mark = db.prepare('UPDATE entries SET branch_depth = ? WHERE id = ?')
      let currentId: string | null = leafId
      let depth = 0
      let compactionDepth: number | null = null
      let firstKeptId: string | null = null
      db.exec('BEGIN')
      while (currentId !== null) {
        const row = byId.get(currentId)
        if (!row) {
          break
        }
        if (row.branch_depth !== null) {
          throw new Error('Pi session branch contains a cycle')
        }
        mark.run(depth, currentId)
        if (compactionDepth === null && row.type === 'compaction') {
          compactionDepth = depth
          firstKeptId = typeof row.first_kept_id === 'string' ? row.first_kept_id : null
        }
        currentId = typeof row.parent_id === 'string' && row.parent_id ? row.parent_id : null
        depth += 1
        if (depth % 1024 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
      db.exec('COMMIT')
      const selected = db.prepare(`SELECT raw_line, fallback_id, line_index FROM entries
        WHERE branch_depth IS NOT NULL AND branch_depth >= ? AND branch_depth <= ?
        ORDER BY branch_depth DESC`)
      const emit = async (from: number, through: number): Promise<void> => {
        let processedRows = 0
        let processedBytes = 0
        let sliceStartedAt = performance.now()
        for (const row of selected.iterate(from, through)) {
          if (
            typeof row.raw_line !== 'string' ||
            typeof row.fallback_id !== 'string' ||
            typeof row.line_index !== 'number'
          ) {
            throw new Error('Pi session branch index is unreadable')
          }
          processedRows += 1
          processedBytes += Buffer.byteLength(row.raw_line, 'utf8')
          const record = parseJsonObject(row.raw_line)
          if (record) {
            const message =
              record.type === 'compaction' || record.type === 'branch_summary'
                ? piSummaryMessage(record, row.fallback_id)
                : asRecord(record.message)?.role === 'system'
                  ? null
                  : decodeOmpTranscriptLine(row.raw_line, row.fallback_id)
            if (message) {
              keep(toItem(message, identify(row.raw_line, row.line_index)))
            }
          }
          if (
            processedBytes >= 1024 * 1024 ||
            performance.now() - sliceStartedAt >= 8 ||
            processedRows >= 256
          ) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            processedRows = 0
            processedBytes = 0
            sliceStartedAt = performance.now()
          }
        }
      }
      if (compactionDepth === null) {
        await emit(0, depth - 1)
        return
      }
      await emit(compactionDepth, compactionDepth)
      const kept = firstKeptId === null ? undefined : byId.get(firstKeptId)
      if (typeof kept?.branch_depth === 'number' && kept.branch_depth > compactionDepth) {
        await emit(compactionDepth + 1, kept.branch_depth)
      }
      if (compactionDepth > 0) {
        await emit(0, compactionDepth - 1)
      }
    },
    close() {
      if (closed) {
        return
      }
      closed = true
      closePiImportDatabase(db)
    }
  }
}

function piSummaryMessage(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  const summary = typeof record.summary === 'string' ? record.summary : ''
  if (record.type === 'branch_summary' && !summary) {
    return null
  }
  const timestamp = timestampMs(record.timestamp)
  return {
    id: typeof record.id === 'string' ? record.id : fallbackId,
    role: 'system',
    blocks: [{ type: 'text', text: summary }],
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript'
  }
}
