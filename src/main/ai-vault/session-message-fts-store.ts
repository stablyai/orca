import type { Database } from 'fts5-sql-bundle'
import { sessionIndexRevision } from '../../shared/ai-vault-session-index'
import type { AiVaultSessionMessageHit } from '../../shared/ai-vault-session-message-hit'
import type { AiVaultRgSearchScope } from '../../shared/ai-vault-session-search-scope'
import {
  aiVaultFtsQueryIsDegraded,
  makeAiVaultLikeSnippet,
  splitAiVaultFtsQuerySegments
} from '../../shared/ai-vault-session-trigram-query'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  ensureMessageFtsSchema,
  readFileMtimeMs,
  sessionHasLocalTranscript
} from './session-message-fts-access'
import { openAiVaultSqlJsDatabase, persistAiVaultSqlJsDatabase } from './session-message-fts-engine'
import {
  searchMessageFtsLike,
  searchMessageFtsMatch,
  selectSqlJsAll,
  type MessageSearchRow
} from './session-message-fts-select'
import {
  extractAiVaultSessionMessageUnits,
  type AiVaultSessionMessageUnit
} from './session-message-units'

export type AiVaultMessageFtsSearchResult = {
  hits: AiVaultSessionMessageHit[]
  matchedIds: string[]
  degraded: boolean
  indexedSessionCount: number
  indexedSessionIds: string[]
}

// Why: tests pause before an exclusive sync so two callers can enqueue first.
export const aiVaultMessageFtsSyncGate = {
  wait: async (): Promise<void> => {}
}

export class AiVaultSessionMessageFtsStore {
  private pendingSync: readonly AiVaultSession[] | null = null
  private inflightSync: Promise<{ upserted: number; deleted: number }> | null = null

  private constructor(
    private readonly dbPath: string,
    private readonly db: Database
  ) {
    ensureMessageFtsSchema(this.db)
  }

  static async open(dbPath: string): Promise<AiVaultSessionMessageFtsStore> {
    return new AiVaultSessionMessageFtsStore(dbPath, await openAiVaultSqlJsDatabase(dbPath))
  }

  close(): void {
    this.db.close()
  }

  async sync(sessions: readonly AiVaultSession[]): Promise<{ upserted: number; deleted: number }> {
    this.pendingSync = sessions
    if (!this.inflightSync) {
      this.inflightSync = this.drainPendingSync().finally(() => {
        this.inflightSync = null
      })
    }
    return this.inflightSync
  }

  private async drainPendingSync(): Promise<{ upserted: number; deleted: number }> {
    let last = { upserted: 0, deleted: 0 }
    while (this.pendingSync) {
      const batch = this.pendingSync
      this.pendingSync = null
      await aiVaultMessageFtsSyncGate.wait()
      last = await this.syncExclusive(batch)
    }
    return last
  }

  private async syncExclusive(
    sessions: readonly AiVaultSession[]
  ): Promise<{ upserted: number; deleted: number }> {
    const existing = this.selectSessionRevisions()
    const seen = new Set<string>()
    const alreadyDeleted = new Set<string>()
    let upserted = 0
    let deleted = 0
    this.db.run('BEGIN')
    try {
      for (const session of sessions) {
        // Why: check locality before the revision skip so a vanished file is
        // dropped and rg can search it instead of serving stale FTS hits.
        if (!(await sessionHasLocalTranscript(session))) {
          if (existing.has(session.id)) {
            this.deleteSession(session.id)
            alreadyDeleted.add(session.id)
            deleted += 1
          }
          continue
        }
        const revision = sessionIndexRevision(session)
        if (existing.get(session.id) === revision) {
          seen.add(session.id)
          continue
        }
        const extracted = await extractAiVaultSessionMessageUnits(session)
        if (!extracted.ok) {
          if (existing.has(session.id)) {
            this.deleteSession(session.id)
            alreadyDeleted.add(session.id)
            deleted += 1
          }
          continue
        }
        seen.add(session.id)
        this.replaceSessionMessages(
          session,
          revision,
          await readFileMtimeMs(session.filePath),
          extracted.units
        )
        upserted += 1
      }
      for (const id of existing.keys()) {
        if (!seen.has(id) && !alreadyDeleted.has(id)) {
          this.deleteSession(id)
          deleted += 1
        }
      }
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
    await persistAiVaultSqlJsDatabase(this.db, this.dbPath)
    return { upserted, deleted }
  }

  search(args: {
    query: string
    searchScope: AiVaultRgSearchScope
    sessionIds: readonly string[]
    limit?: number
  }): AiVaultMessageFtsSearchResult {
    const segments = splitAiVaultFtsQuerySegments(args.query)
    const sessionIds = args.sessionIds.map(String)
    const indexedSessionIds = this.selectIndexedIds(sessionIds)
    const indexedSessionCount = indexedSessionIds.length
    if (segments.length === 0 || sessionIds.length === 0) {
      return { hits: [], matchedIds: [], degraded: false, indexedSessionCount, indexedSessionIds }
    }
    const degraded = aiVaultFtsQueryIsDegraded(segments)
    const rows = degraded
      ? searchMessageFtsLike(this.db, segments, args.searchScope, sessionIds, args.limit ?? 80)
      : searchMessageFtsMatch(this.db, segments, args.searchScope, sessionIds, args.limit ?? 80)
    const hits = rows.map((row) => toMessageHit(row, segments[0] ?? args.query, degraded))
    return {
      hits,
      matchedIds: uniqueSessionIds(hits),
      degraded,
      indexedSessionCount,
      indexedSessionIds
    }
  }

  private selectSessionRevisions(): Map<string, string> {
    const rows = selectSqlJsAll(this.db, 'SELECT id, revision FROM sessions', []) as {
      id: string
      revision: string
    }[]
    return new Map(rows.map((row) => [row.id, row.revision]))
  }

  private selectIndexedIds(sessionIds: readonly string[]): string[] {
    if (sessionIds.length === 0) {
      return []
    }
    const rows = selectSqlJsAll(
      this.db,
      `SELECT id FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(', ')})`,
      [...sessionIds]
    ) as { id: string }[]
    return rows.map((row) => row.id)
  }

  private replaceSessionMessages(
    session: AiVaultSession,
    revision: string,
    fileMtime: number,
    units: readonly AiVaultSessionMessageUnit[]
  ): void {
    this.deleteSession(session.id)
    this.db.run('INSERT INTO sessions (id, revision, file_path, file_mtime) VALUES (?, ?, ?, ?)', [
      session.id,
      revision,
      session.filePath,
      fileMtime
    ])
    for (const unit of units) {
      this.db.run(
        'INSERT INTO messages (session_id, seq, role, file_path, byte_offset, line_number, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          session.id,
          unit.seq,
          unit.role,
          unit.filePath,
          unit.byteOffset,
          unit.lineNumber,
          unit.text
        ]
      )
      const row = selectSqlJsAll(this.db, 'SELECT last_insert_rowid() AS id', [])[0] as {
        id: number
      }
      this.db.run('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)', [row.id, unit.text])
    }
  }

  private deleteSession(sessionId: string): void {
    const rows = selectSqlJsAll(this.db, 'SELECT id, text FROM messages WHERE session_id = ?', [
      sessionId
    ]) as { id: number; text: string }[]
    for (const row of rows) {
      this.db.run("INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', ?, ?)", [
        row.id,
        row.text
      ])
    }
    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
  }
}

const storesByPath = new Map<string, Promise<AiVaultSessionMessageFtsStore>>()

export function getAiVaultSessionMessageFtsStore(
  dbPath: string
): Promise<AiVaultSessionMessageFtsStore> {
  const existing = storesByPath.get(dbPath)
  if (existing) {
    return existing
  }
  const opened = AiVaultSessionMessageFtsStore.open(dbPath)
  storesByPath.set(dbPath, opened)
  return opened
}

function toMessageHit(
  row: MessageSearchRow,
  firstSegment: string,
  degraded: boolean
): AiVaultSessionMessageHit {
  return {
    sessionId: row.session_id,
    role: row.role,
    snippet: degraded ? makeAiVaultLikeSnippet(row.text, firstSegment) : String(row.snippet),
    jump: {
      sessionId: row.session_id,
      messageId: Number(row.id),
      filePath: row.file_path,
      lineNumber: Number(row.line_number),
      byteOffset: Number(row.byte_offset),
      matchLength: [...firstSegment].length
    }
  }
}

function uniqueSessionIds(hits: readonly AiVaultSessionMessageHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.sessionId))]
}
