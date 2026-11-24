import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { buildOpenCodeSqliteCandidatePath } from '../../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import type SyncDatabase from '../../../sqlite/sync-database'
import { scopedSessionRows } from '../session-scanner-sqlite-scope-rows'
import { createAccumulator, finalizeSession } from '../../parsing/session-scanner-accumulator'
import { addSessionContent } from '../../parsing/session-scanner-messages'
import { parseJsonObject } from '../../parsing/session-json-object'
import { shouldCaptureFullFirstUserPrompt } from '../../prompts/session-scanner-first-user-prompt'
import {
  extractContentText,
  normalizeTitleText
} from '../../parsing/session-scanner-text-normalization'
import { extractString } from '../../../../shared/text/trimmed-string'
import type { FileWithMtime, SessionFileCandidate } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from '../opencode/sqlite/session-scanner-opencode-sqlite-open'
import {
  OPENCODE_CAPTURE_RECORD_LIMIT,
  OPENCODE_CAPTURE_TEXT_LIMIT,
  captureWithTextBudget
} from '../opencode/sqlite/opencode-transcript-capture-limits'
import { unixSecondsToIso } from './session-scanner-devin-db'

const SESSION_FIELDS =
  'id, working_directory AS directory, title, model, created_at, last_activity_at, main_chain_id'
const REVISION_CACHE_LIMIT = 8
const revisionCache = new Map<string, { stamp: string; sessions: Map<string, number> }>()

function sessionFile(dbPath: string, id: string, row: Record<string, unknown>): FileWithMtime {
  const modifiedAt =
    unixSecondsToIso(row.last_activity_at) ??
    unixSecondsToIso(row.created_at) ??
    new Date(0).toISOString()
  return {
    path: buildOpenCodeSqliteCandidatePath(dbPath, id),
    mtimeMs: Date.parse(modifiedAt),
    modifiedAt
  }
}

async function databaseRevision(dbPath: string): Promise<string> {
  const stamps = await Promise.all(
    [dbPath, `${dbPath}-wal`].map(async (path) => {
      try {
        const info = await stat(path, { bigint: true })
        return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      } catch (error) {
        if (path !== dbPath && isMissingTranscriptPathError(error)) {
          return ''
        }
        throw error
      }
    })
  )
  return stamps.join('|')
}

function cachedRevisions(dbPath: string, stamp: string): Map<string, number> {
  const previous = revisionCache.get(dbPath)
  if (previous?.stamp === stamp) {
    return previous.sessions
  }
  revisionCache.delete(dbPath)
  const oldest = revisionCache.keys().next().value
  if (revisionCache.size >= REVISION_CACHE_LIMIT && oldest !== undefined) {
    revisionCache.delete(oldest)
  }
  const sessions = new Map<string, number>()
  revisionCache.set(dbPath, { stamp, sessions })
  return sessions
}

function sessionRevision(
  row: Record<string, unknown>,
  nodes: Iterable<Record<string, unknown>>,
  stamp: string
): number {
  const hash = createHash('sha256').update(JSON.stringify(row))
  let records = 0
  let chars = 0
  for (const node of nodes) {
    const message = node.chat_message
    chars += typeof message === 'string' ? message.length : 0
    if (++records > OPENCODE_CAPTURE_RECORD_LIMIT || chars > OPENCODE_CAPTURE_TEXT_LIMIT) {
      // Do not fingerprint an unbounded forest; use the store revision past the read budget.
      hash.update(stamp)
      break
    }
    hash.update(JSON.stringify(node))
  }
  return hash.digest().readUIntBE(0, 6)
}

export async function listDevinSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  const scopePaths = args.scopePaths ?? []
  for (const dbPath of args.dbPaths) {
    try {
      // Reuse fingerprints only while both files are quiet; store changes do not imply session changes.
      const stamp = await databaseRevision(dbPath)
      const revisions = cachedRevisions(dbPath, stamp)
      readOpenCodeDatabase({
        dbPath,
        read: (db) => {
          db.exec('BEGIN')
          const nodes = db.prepare(`SELECT node_id, parent_node_id, created_at, chat_message
            FROM message_nodes WHERE session_id = ? ORDER BY node_id`)
          // An unsupported message schema must not look like a successfully enumerated empty store.
          nodes.get(null)
          const rows = db
            .prepare(`SELECT ${SESSION_FIELDS} FROM sessions
              WHERE hidden = 0 ORDER BY last_activity_at DESC, id LIMIT ?`)
            .iterate(scopePaths.length || !Number.isFinite(args.limit) ? -1 : args.limit)
          const selected = scopePaths.length
            ? scopedSessionRows(rows, scopePaths, args.limit, dbPath)
            : rows
          for (const row of selected) {
            const id = extractString(row.id)
            if (id && !id.includes('#')) {
              const revision = revisions.get(id) ?? sessionRevision(row, nodes.iterate(id), stamp)
              revisions.set(id, revision)
              candidates.push({
                agent: 'devin',
                file: { ...sessionFile(dbPath, id, row), sizeBytes: revision },
                codexHome: null
              })
            }
          }
        }
      })
    } catch (error) {
      args.issues.push(openCodeDatabaseScanIssue(dbPath, error, 'devin'))
    }
  }
  return candidates
}

export function parseDevinSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  messages?: TranscriptMessageSink
}): AiVaultSession | null {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => {
      // Keep the head and its parents in one WAL snapshot; closing the connection releases it.
      db.exec('BEGIN')
      const row = db
        .prepare(`SELECT ${SESSION_FIELDS} FROM sessions WHERE id = ? AND hidden = 0`)
        .get(args.sessionId)
      if (!row) {
        return null
      }
      const chain = readMainChain(db, args.sessionId, row.main_chain_id)
      if (chain.incomplete) {
        if (shouldCaptureFullFirstUserPrompt()) {
          return null
        }
        args.messages?.markIncomplete?.()
      }
      const accumulator = createAccumulator({
        agent: 'devin',
        file: sessionFile(args.dbPath, args.sessionId, row),
        sessionId: args.sessionId,
        messages: chain.incomplete ? undefined : args.messages
      })
      accumulator.previewMessagesTruncated = chain.incomplete
      accumulator.title = normalizeTitleText(extractString(row.title) ?? '')
      accumulator.cwd = extractString(row.directory)
      accumulator.model = extractString(row.model)
      accumulator.createdAt = unixSecondsToIso(row.created_at)
      accumulator.updatedAt = unixSecondsToIso(row.last_activity_at)
      for (const message of chain.messages) {
        if (addSessionContent(accumulator, message.role, message.content, message.timestamp)) {
          accumulator.messageCount++
        }
        if (message.role === 'user' && !chain.incomplete) {
          accumulator.fallbackTitle ??= extractContentText(message.content)
        }
      }
      return finalizeSession(accumulator, args.platform)
    }
  })
}

export function captureDevinSqliteSession(
  args: Omit<Parameters<typeof parseDevinSqliteSession>[0], 'messages'>
) {
  let incomplete: true | undefined
  const { result, messages } = captureWithTextBudget('Devin', (sink) =>
    parseDevinSqliteSession({
      ...args,
      messages: {
        ...sink,
        markIncomplete: () => {
          incomplete = true
        }
      }
    })
  )
  return { session: result, messages, ...(incomplete ? { incomplete } : {}) }
}

function mainChainLookup(db: SyncDatabase) {
  return db.prepare(`SELECT parent_node_id, created_at, CASE WHEN json_valid(chat_message)
    THEN CASE WHEN json_extract(chat_message, '$.role') = 'assistant' OR
      (json_extract(chat_message, '$.role') = 'user' AND json_extract(chat_message, '$.metadata.is_user_input') = 1)
    THEN chat_message END END AS visible_message
    FROM message_nodes WHERE session_id = ? AND node_id = ?`)
}

type DevinMessage = { role: 'assistant' | 'user'; content: unknown; timestamp: string | null }

function readMainChain(
  db: SyncDatabase,
  sessionId: string,
  head: unknown
): {
  messages: DevinMessage[]
  incomplete: boolean
} {
  // Resolve parent IDs within this session only; alternate branches never reach the text scan.
  const lookup = mainChainLookup(db)
  const seen = new Set<number>()
  const messages: DevinMessage[] = []
  let chars = 0
  let nodeId = head
  while (typeof nodeId === 'number') {
    const node = lookup.get(sessionId, nodeId)
    if (!node || seen.has(nodeId)) {
      throw new Error('Devin transcript has a missing or cyclic main-chain link')
    }
    seen.add(nodeId)
    nodeId = node.parent_node_id
    const json = node.visible_message
    chars += typeof json === 'string' ? json.length : 0
    if (seen.size > OPENCODE_CAPTURE_RECORD_LIMIT || chars > OPENCODE_CAPTURE_TEXT_LIMIT) {
      return { messages: messages.toReversed(), incomplete: true }
    }
    const message = typeof json === 'string' ? parseJsonObject(json) : null
    if (message?.role === 'assistant' || message?.role === 'user') {
      messages.push({
        role: message.role,
        content: message.content,
        timestamp: unixSecondsToIso(node.created_at)
      })
    }
  }
  return { messages: messages.toReversed(), incomplete: false }
}
