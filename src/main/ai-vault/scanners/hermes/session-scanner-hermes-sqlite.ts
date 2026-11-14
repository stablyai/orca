import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { errorMessage } from '../../../../shared/error-message'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent } from '../../parsing/session-scanner-messages'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import { extractContentText } from '../../parsing/session-scanner-text-normalization'
import { readHermesSessions } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import { timestampMs } from '../../../foreign-sqlite-readers/hermes-sessions-result'

// Why: Hermes migrated session storage to a SQLite database (state.db).
// This module lists and parses individual sessions from the DB into AiVaultSession objects.

/**
 * Reads the session IDs the SQLite scanner actually surfaces, for deduplication.
 * Unlimited but filtered exactly like the list query: a shell the migration left
 * without messages must not evict the legacy JSON file that still holds the turns.
 */
export async function listHermesSqliteSessionIds(dbPaths: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const dbPath of dbPaths) {
    try {
      const result = await readHermesSessions({ operation: 'ids', dbPath })
      if (result.operation === 'ids') {
        for (const id of result.ids) {
          ids.add(id)
        }
      }
    } catch {
      // Ignore unreadable database paths
    }
  }
  return ids
}

/**
 * List Hermes sessions from one or more SQLite databases as synthetic
 * `SessionFileCandidate` entries. Each candidate's file path is a synthetic
 * `<dbPath>#<sessionId>` string that the parser dispatcher routes to
 * `parseHermesSqliteSession`.
 * @param args.dbPaths - Absolute paths to state.db files to scan.
 * @param args.limit - Maximum number of sessions to return per database.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns Array of synthetic candidates sorted by recency.
 */
export async function listHermesSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  for (const dbPath of args.dbPaths) {
    try {
      const result = await readHermesSessions({
        operation: 'list',
        dbPath,
        limit: args.limit,
        scopePaths: args.scopePaths
      })
      if (result.operation === 'list') {
        candidates.push(
          ...result.files.map((file) => ({ agent: 'hermes' as const, file, codexHome: null }))
        )
      }
    } catch (err) {
      if (!args.issues.some((issue) => issue.agent === 'hermes' && issue.path === dbPath)) {
        args.issues.push({ agent: 'hermes', path: dbPath, message: errorMessage(err) })
      }
    }
  }
  candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
  return candidates
}

/**
 * Parse a single Hermes session from the SQLite database into an `AiVaultSession`.
 * Reads session metadata (title, cwd, model, timeline) and preview messages from
 * the `sessions` and `messages` tables.
 * @param args.dbPath - Absolute path to the state.db file.
 * @param args.sessionId - The session ID (primary key in the `sessions` table).
 * @param args.platform - The platform to use for resume command generation.
 * @param args.messages - Where the parser publishes every decoded message.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist.
 */
export async function parseHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  // Let read failures propagate so the transcript reader reports an incomplete read.
  const result = await readHermesSessions({
    operation: 'session',
    dbPath: args.dbPath,
    sessionId: args.sessionId
  })
  if (result.operation !== 'session' || !result.session) {
    return null
  }
  const { row, mtimeMs, messages } = result.session
  const file = {
    path: buildHermesSqliteCandidatePath(args.dbPath, args.sessionId),
    mtimeMs,
    modifiedAt: new Date(mtimeMs).toISOString()
  }

  const accumulator = createAccumulator({
    agent: 'hermes',
    file,
    sessionId: args.sessionId,
    messages: args.messages
  })

  if (row.model) {
    accumulator.model = row.model
  }
  if (row.cwd) {
    accumulator.cwd = row.cwd
  }
  if (row.title) {
    accumulator.title = row.title
  }

  updateTimeline(accumulator, timestampMs(row.created_at))
  updateTimeline(accumulator, mtimeMs)

  for (const msg of messages) {
    const role = msg.role
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      if (role === 'user' && !accumulator.title) {
        accumulator.title = extractContentText(msg.content)
      }
      addSessionContent(accumulator, role, msg.content)
    }
  }

  return finalizeSession(accumulator, args.platform)
}
