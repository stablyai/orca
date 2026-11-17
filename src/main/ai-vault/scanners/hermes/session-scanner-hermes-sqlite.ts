import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { buildOpenCodeSqliteCandidatePath } from '../../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import type SyncDatabase from '../../../sqlite/sync-database'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addDecodedSessionMessage } from '../../parsing/session-scanner-messages'
import { parseJsonObject } from '../../parsing/session-json-object'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import {
  extractFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from '../../prompts/session-scanner-first-user-prompt'
import type {
  TranscriptMessage,
  TranscriptMessageSink
} from '../../transcripts/session-transcript-consumers'
import type { SessionFileCandidate } from '../../session-scanner-types'
import {
  captureWithTextBudget,
  OPENCODE_CAPTURE_RECORD_LIMIT
} from '../opencode/sqlite/opencode-transcript-capture-limits'
import {
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from '../opencode/sqlite/session-scanner-opencode-sqlite-open'
import { scopedSessionRows } from '../session-scanner-sqlite-scope-rows'
import {
  hermesConversationActivity,
  hermesConversationRecency,
  readHermesSegmentActivity
} from './hermes-state-db-activity'
import {
  listHermesConversations,
  readHermesConversation,
  type HermesConversation
} from './hermes-state-db-conversations'
import { readHermesSchema, type HermesSchema } from './hermes-state-db-schema'
import {
  decodeHermesMessage,
  displayedMessages,
  readMessageBodies,
  readMessageIdentities,
  type MessageIdentity
} from './hermes-state-db-messages'

// Enough recent turns to fill the five-message preview past tool-call-only assistant turns.
const PREVIEW_TURNS = 12

function conversationCwd(conversation: HermesConversation): string | null {
  for (const segment of conversation.segments) {
    if (segment.cwd) {
      return segment.cwd
    }
    const configured = segment.model_config ? parseJsonObject(segment.model_config)?.cwd : null
    if (typeof configured === 'string' && configured) {
      return configured
    }
  }
  return null
}

// Headroom over the limit for empty conversations and `last_activity_at` lagging a heartbeat.
const RECENCY_SLACK = (limit: number) => Math.ceil(limit * 1.5) + 32

/** Newest `limit` conversations, plus with `scopePaths` the newest `limit` in scope, newest first;
 *  never reads message bodies. A finite limit reads activity for only the most recent candidates. */
export function listHermesSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
}): SessionFileCandidate[] {
  const candidates: SessionFileCandidate[] = []
  const limited = Number.isFinite(args.limit)
  for (const dbPath of args.dbPaths) {
    try {
      const rows = readOpenCodeDatabase({
        dbPath,
        read: (db) => {
          const schema = readHermesSchema(db, dbPath)
          if (!schema) {
            return []
          }
          const scoped = Boolean(args.scopePaths?.length)
          const window = RECENCY_SLACK(args.limit)
          // Stores older than last_activity_at have no recency of their own; read them whole.
          const windowed = limited && schema.sessions.has('last_activity_at')
          // A limited, unscoped list reads only the most recent session rows; a scope can reach any age.
          const conversations = listHermesConversations(
            db,
            schema,
            windowed && !scoped ? window : undefined
          ).map((conversation) => ({ conversation, directory: conversationCwd(conversation) }))
          const newest = (list: typeof conversations) =>
            list
              .toSorted(
                (left, right) =>
                  hermesConversationRecency(right.conversation) -
                  hermesConversationRecency(left.conversation)
              )
              .slice(0, window)
          const chosen = windowed
            ? new Set([
                ...newest(conversations),
                ...(scoped
                  ? newest(scopedSessionRows(conversations, args.scopePaths!, Infinity, dbPath))
                  : [])
              ])
            : new Set(conversations)
          const segmentIds = [...chosen].flatMap(({ conversation }) =>
            conversation.segments.map((segment) => segment.id)
          )
          // An indexed search per chosen session; only an unlimited sweep reads the whole index.
          const activity = readHermesSegmentActivity(db, schema, windowed ? segmentIds : undefined)
          return [...chosen]
            .map((row) => ({
              ...row,
              activity: hermesConversationActivity(row.conversation, activity)
            }))
            .filter((row) => row.activity.live > 0)
            .sort((left, right) => right.activity.updatedMs - left.activity.updatedMs)
        }
      })
      const admitted = new Set([
        ...rows.slice(0, limited ? args.limit : undefined),
        ...(args.scopePaths?.length
          ? scopedSessionRows(rows, args.scopePaths, args.limit, dbPath)
          : [])
      ])
      for (const { conversation, activity } of admitted) {
        candidates.push({
          agent: 'hermes',
          file: {
            path: buildOpenCodeSqliteCandidatePath(dbPath, conversation.id),
            mtimeMs: activity.updatedMs,
            modifiedAt: new Date(activity.updatedMs).toISOString(),
            // Times alone miss rewinds and in-place rewrites; the revision moves with every one.
            sizeBytes: activity.revision
          },
          codexHome: null
        })
      }
    } catch (error) {
      args.issues.push(openCodeDatabaseScanIssue(dbPath, error, 'hermes'))
    }
  }
  return candidates.sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
}

function firstUserTextParts(
  db: SyncDatabase,
  schema: HermesSchema,
  turns: readonly MessageIdentity[],
  full: boolean
): string[] {
  // One body at a time: the first user turn almost always has text, and full reads can be large.
  for (const user of turns.filter((turn) => turn.role === 'user').slice(0, 5)) {
    for (const row of readMessageBodies(db, schema, [user], { full, tools: false })) {
      const parts = decodeHermesMessage(row, false).blocks.flatMap((block) =>
        block.kind === 'text' ? [block.text] : []
      )
      if (parts.some((part) => part.trim())) {
        return parts
      }
    }
  }
  return []
}

function conversationTitle(conversation: HermesConversation): string | null {
  for (const segment of conversation.segments.toReversed()) {
    const title = segment.title ? normalizeTitleText(segment.title) : null
    if (title) {
      return title
    }
  }
  return null
}

/** Reads one conversation's metadata and preview; with an active sink, its whole display transcript. */
export function parseHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  messages?: TranscriptMessageSink
}): AiVaultSession | null {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => {
      const schema = readHermesSchema(db, args.dbPath)
      const conversation = schema && readHermesConversation(db, schema, args.sessionId)
      if (!schema || !conversation) {
        return null
      }
      const includeTools = Boolean(args.messages?.active)
      const displayed = displayedMessages(readMessageIdentities(db, schema, conversation))
      const turns = displayed.filter((row) => row.role === 'user' || row.role === 'assistant')
      if (turns.length === 0) {
        return null
      }
      if (includeTools && displayed.length > OPENCODE_CAPTURE_RECORD_LIMIT) {
        throw new Error('Hermes transcript exceeds capture limits; no partial read was published')
      }
      const segmentIds = conversation.segments.map((segment) => segment.id)
      const activity = hermesConversationActivity(
        conversation,
        readHermesSegmentActivity(db, schema, segmentIds)
      )
      const accumulator = createAccumulator({
        agent: 'hermes',
        // `<db>#<id>` names one conversation and is no readable file, so no client hands the store over.
        file: {
          path: buildOpenCodeSqliteCandidatePath(args.dbPath, conversation.id),
          mtimeMs: activity.updatedMs,
          modifiedAt: new Date(activity.updatedMs).toISOString()
        },
        sessionId: conversation.id,
        messages: args.messages
      })
      accumulator.title = conversationTitle(conversation)
      accumulator.cwd = conversationCwd(conversation)
      accumulator.model = conversation.segments.at(-1)!.model
      accumulator.messageCount = turns.length
      updateTimeline(accumulator, activity.createdMs)
      updateTimeline(accumulator, activity.updatedMs)
      // Most Hermes rows carry a title; only untitled rows and full-prompt reads need the first turn.
      const fullPrompt = shouldCaptureFullFirstUserPrompt()
      if (!accumulator.title || fullPrompt) {
        const firstUser = firstUserTextParts(db, schema, turns, fullPrompt).join('\n')
        accumulator.title ??= normalizeTitleText(firstUser)
        if (fullPrompt) {
          accumulator.firstUserPrompt = extractFullFirstUserPromptText(firstUser)
        }
      }
      const shown = includeTools ? displayed : turns.slice(-PREVIEW_TURNS)
      if (!includeTools && turns.length > shown.length) {
        accumulator.previewMessagesTruncated = true
      }
      for (const row of readMessageBodies(db, schema, shown, {
        full: includeTools,
        tools: includeTools
      })) {
        addDecodedSessionMessage(accumulator, decodeHermesMessage(row, includeTools), {
          seedFirstUserPrompt: false
        })
      }
      return finalizeSession(accumulator, args.platform)
    }
  })
}

export function captureHermesSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): { session: AiVaultSession | null; messages: TranscriptMessage[] } {
  const { result, messages } = captureWithTextBudget('Hermes', (sink) =>
    parseHermesSqliteSession({ ...args, messages: sink })
  )
  return { session: result, messages }
}
