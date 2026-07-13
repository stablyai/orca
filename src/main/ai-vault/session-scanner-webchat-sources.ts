import { existsSync } from 'node:fs'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { errorMessage } from './session-scanner-values'

const SOURCE_TO_AGENT = { CHATGPT: 'chatgpt', CLAUDE: 'claude-web', GEMINI: 'gemini-web' } as const

type Row = {
  id: string
  source: string
  external_id: string
  updated_at: string | null
  created_at: string | null
}

/**
 * List one session candidate per imported web conversation, read from the
 * chat-import SQLite DB. Each candidate's agent is derived from that
 * conversation's own source column (chatgpt/claude-web/gemini-web can be
 * mixed in a single DB), and its synthetic path is `<dbPath>#<source>/<externalId>`
 * so `parseAgentSessionFile` can route it back to `parseWebChatSqliteSession`.
 */
export function listWebChatCandidates(args: {
  dbPath: string
  issues: AiVaultScanIssue[]
}): SessionFileCandidate[] {
  if (!existsSync(args.dbPath)) {
    return []
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(args.dbPath, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    if (!tableExists(db, 'conversations')) {
      return []
    }
    const rows = db
      .prepare(
        `SELECT id, source, external_id, updated_at, created_at FROM conversations
         WHERE source IN ('CHATGPT','CLAUDE','GEMINI')
         ORDER BY COALESCE(updated_at, created_at, synced_at) DESC`
      )
      .all() as Row[]
    return rows
      .filter(
        (r): r is Row & { source: keyof typeof SOURCE_TO_AGENT } => r.source in SOURCE_TO_AGENT
      )
      .map((r) => {
        const mtimeMs = Date.parse(r.updated_at ?? r.created_at ?? '') || 0
        return {
          agent: SOURCE_TO_AGENT[r.source],
          file: {
            path: `${args.dbPath}#${r.id}`,
            mtimeMs,
            modifiedAt: mtimeMs ? new Date(mtimeMs).toISOString() : new Date(0).toISOString()
          },
          codexHome: null
        }
      })
  } catch (err) {
    args.issues.push({ agent: 'chatgpt', path: args.dbPath, message: errorMessage(err) })
    return []
  } finally {
    db?.close()
  }
}
