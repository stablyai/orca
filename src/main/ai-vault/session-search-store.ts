import type { AiVaultSession } from '../../shared/ai-vault-types'
import { deriveAiVaultSessionHost } from '../../shared/ai-vault-session-host'
import { sessionIndexRevision } from '../../shared/ai-vault-session-index'
import { sessionPreviewSearchText } from '../../shared/ai-vault-session-preview-text'
import { tokenizeIndexText } from '../../shared/ai-vault-session-query'
import SyncDatabase from '../sqlite/sync-database'

export type AiVaultFtsSyncResult = {
  upserted: number
  deleted: number
}

type SessionMetaRow = {
  id: string
  revision: string
}

export class AiVaultSessionFtsStore {
  private readonly db: SyncDatabase

  constructor(dbPath: string) {
    this.db = new SyncDatabase(dbPath)
    // Why: Electron/Node node:sqlite in this tree does not ship FTS5, so the
    // durable vault index is a posting-list table instead of a virtual FTS table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        host TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_tokens (
        token TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (token, session_id)
      );
      CREATE INDEX IF NOT EXISTS session_tokens_token_idx ON session_tokens(token);
    `)
  }

  close(): void {
    this.db.close()
  }

  sync(sessions: readonly AiVaultSession[]): AiVaultFtsSyncResult {
    const existing = new Map(
      (this.db.prepare('SELECT id, revision FROM session_meta').all() as SessionMetaRow[]).map(
        (row) => [row.id, row.revision]
      )
    )
    let upserted = 0
    let deleted = 0
    const seen = new Set<string>()

    for (const session of sessions) {
      seen.add(session.id)
      const revision = sessionIndexRevision(session)
      if (existing.get(session.id) === revision) {
        continue
      }
      this.upsertSession(session, revision)
      upserted += 1
    }

    for (const id of existing.keys()) {
      if (seen.has(id)) {
        continue
      }
      this.deleteSession(id)
      deleted += 1
    }

    return { upserted, deleted }
  }

  query(terms: readonly string[], mode: 'and' | 'or' = 'and', limit = 80): string[] {
    const tokens = uniqueIndexTokens(terms)
    if (tokens.length === 0) {
      return []
    }
    const placeholders = tokens.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT session_id AS id, COUNT(DISTINCT token) AS hits
         FROM session_tokens
         WHERE token IN (${placeholders})
         GROUP BY session_id
         HAVING hits ${mode === 'and' ? '=' : '>='} ?
         ORDER BY hits DESC
         LIMIT ?`
      )
      .all(...tokens, mode === 'and' ? tokens.length : 1, limit) as { id: string }[]
    return rows.map((row) => row.id)
  }

  private upsertSession(session: AiVaultSession, revision: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteSession(session.id)
      this.db
        .prepare('INSERT INTO session_meta (id, revision, host) VALUES (?, ?, ?)')
        .run(session.id, revision, deriveAiVaultSessionHost(session))
      const insertToken = this.db.prepare(
        'INSERT OR IGNORE INTO session_tokens (token, session_id) VALUES (?, ?)'
      )
      for (const token of uniqueIndexTokens([
        session.title,
        session.sessionId,
        session.agent,
        session.branch ?? '',
        session.model ?? '',
        session.cwd ?? '',
        session.filePath,
        sessionPreviewSearchText(session)
      ])) {
        insertToken.run(token, session.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private deleteSession(id: string): void {
    this.db.prepare('DELETE FROM session_tokens WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM session_meta WHERE id = ?').run(id)
  }
}

const storesByPath = new Map<string, AiVaultSessionFtsStore>()

export function getAiVaultSessionFtsStore(dbPath: string): AiVaultSessionFtsStore {
  const existing = storesByPath.get(dbPath)
  if (existing) {
    return existing
  }
  const store = new AiVaultSessionFtsStore(dbPath)
  storesByPath.set(dbPath, store)
  return store
}

function uniqueIndexTokens(terms: readonly string[]): string[] {
  const tokens: string[] = []
  for (const term of terms) {
    for (const token of tokenizeIndexText(term)) {
      if (!tokens.includes(token)) {
        tokens.push(token)
      }
    }
  }
  return tokens
}
