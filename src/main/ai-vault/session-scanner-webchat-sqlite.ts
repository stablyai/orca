import type { AiVaultSession } from '../../shared/ai-vault-types'
import { SOURCE_TO_AGENT, type WebChatSource } from '../chat-import/chat-import-store'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { normalizeTitleText } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { statSync } from 'node:fs'

type ConvRow = { title: string | null; created_at: string | null; updated_at: string | null }
type MsgRow = { role: string; text: string | null; created_at: string | null }

function openReadonly(dbPath: string): SyncDatabase {
  // Why: query_only (not OS readonly) so we can safely read a WAL-mode DB
  // written by the native host — an OS-readonly handle can't attach the -shm.
  const db = new SyncDatabase(dbPath, { fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

export function parseWebChatSqliteSession(args: {
  dbPath: string
  sessionId: string
  source: WebChatSource
  platform: NodeJS.Platform
}): AiVaultSession | null {
  let db: SyncDatabase | null = null
  try {
    db = openReadonly(args.dbPath)
    if (!tableExists(db, 'conversations') || !tableExists(db, 'messages')) {
      return null
    }
    const convId = `${args.source}/${args.sessionId}`
    const conv = db
      .prepare('SELECT title, created_at, updated_at FROM conversations WHERE id = ?')
      .get(convId) as ConvRow | undefined
    if (!conv) {
      return null
    }
    const mtimeMs = statSync(args.dbPath).mtimeMs
    const accumulator = createAccumulator({
      agent: SOURCE_TO_AGENT[args.source],
      file: {
        path: `${args.dbPath}#${convId}`,
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString()
      },
      sessionId: args.sessionId
    })
    accumulator.readOnly = true
    accumulator.title = normalizeTitleText(conv.title ?? '')
    updateTimeline(accumulator, conv.created_at)
    updateTimeline(accumulator, conv.updated_at)

    const rows = db
      .prepare('SELECT role, text, created_at FROM messages WHERE conv_id = ? ORDER BY idx ASC')
      .all(convId) as MsgRow[]
    for (const row of rows) {
      const text = row.text
      if (!text) {
        continue
      }
      const role = row.role === 'USER' ? 'user' : 'assistant'
      accumulator.messageCount += 1
      addPreviewMessage(accumulator, { role, text, timestamp: row.created_at ?? undefined })
      if (role === 'user' && !accumulator.title) {
        accumulator.title = normalizeTitleText(text)
      }
    }
    return finalizeSession(accumulator, args.platform)
  } finally {
    db?.close()
  }
}
