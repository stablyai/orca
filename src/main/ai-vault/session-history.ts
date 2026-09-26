import type { NativeChatMessage } from '../../shared/native-chat-types'
import { isNativeChatSupportedAgent } from '../../shared/native-chat-agent-support'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  AiVaultHistoryMessage,
  AiVaultHistoryReadResult,
  AiVaultHistorySearchMatch,
  AiVaultHistorySearchResult
} from '../../shared/ai-vault-history-types'
import { listAiVaultSessions } from './cached-session-list'
import { readNativeChatTranscript } from '../native-chat/transcript-reader'

export const AI_VAULT_HISTORY_SEARCH_RESULT_LIMIT = 50
export const AI_VAULT_HISTORY_READ_MESSAGE_LIMIT = 200
const AI_VAULT_HISTORY_TEXT_MAX_LENGTH = 32 * 1024
const AI_VAULT_HISTORY_MESSAGE_ID_MAX_LENGTH = 1024

export type {
  AiVaultHistoryMessage,
  AiVaultHistoryReadResult,
  AiVaultHistorySearchMatch,
  AiVaultHistorySearchResult
} from '../../shared/ai-vault-history-types'

type HistoryDependencies = {
  listSessions: typeof listAiVaultSessions
  readTranscript: typeof readNativeChatTranscript
}

const defaultDependencies: HistoryDependencies = {
  listSessions: listAiVaultSessions,
  readTranscript: readNativeChatTranscript
}

/**
 * Searches normalized transcript messages discovered by AI Vault. File paths
 * remain host-private; callers can only address a result by agent/session id.
 */
export async function searchAiVaultHistory(
  args: { query: string; limit?: number; scopePaths?: readonly string[] },
  dependencies: HistoryDependencies = defaultDependencies
): Promise<AiVaultHistorySearchResult> {
  const query = args.query.trim().toLocaleLowerCase()
  if (!query) {
    return { matches: [], scannedSessionCount: 0 }
  }
  const limit = clampLimit(args.limit, AI_VAULT_HISTORY_SEARCH_RESULT_LIMIT)
  const listed = await dependencies.listSessions({
    unlimited: true,
    scopePaths: args.scopePaths
  })
  const sessions = listed.sessions.filter(isHistoryReadableSession)
  const matches: AiVaultHistorySearchMatch[] = []
  for (const session of sessions) {
    if (matches.length >= limit) {
      break
    }
    const transcript = await dependencies.readTranscript(session.agent, session.sessionId, {
      filePath: session.filePath
    })
    if (!('messages' in transcript)) {
      continue
    }
    for (const message of transcript.messages) {
      const historyMessage = toHistoryMessage(message)
      if (!historyMessage || !historyMessage.text.toLocaleLowerCase().includes(query)) {
        continue
      }
      matches.push({
        agent: session.agent,
        sessionId: session.sessionId,
        title: session.title.slice(0, 512),
        updatedAt: session.updatedAt,
        message: historyMessage
      })
      if (matches.length >= limit) {
        break
      }
    }
  }
  return { matches, scannedSessionCount: sessions.length }
}

export async function readAiVaultHistorySession(
  args: { agent: AiVaultAgent; sessionId: string; limit?: number },
  dependencies: HistoryDependencies = defaultDependencies
): Promise<AiVaultHistoryReadResult> {
  if (!isNativeChatSupportedAgent(args.agent) || !args.sessionId.trim()) {
    return { messages: [], truncated: false }
  }
  const listed = await dependencies.listSessions({ unlimited: true })
  const session = listed.sessions.find(
    (candidate) =>
      candidate.agent === args.agent &&
      candidate.sessionId === args.sessionId &&
      isHistoryReadableSession(candidate)
  )
  if (!session) {
    return { messages: [], truncated: false }
  }
  const transcript = await dependencies.readTranscript(session.agent, session.sessionId, {
    filePath: session.filePath
  })
  if (!('messages' in transcript)) {
    return { messages: [], truncated: false }
  }
  const messages = transcript.messages.flatMap((message) => {
    const normalized = toHistoryMessage(message)
    return normalized ? [normalized] : []
  })
  const limit = clampLimit(args.limit, AI_VAULT_HISTORY_READ_MESSAGE_LIMIT)
  return { messages: messages.slice(0, limit), truncated: messages.length > limit }
}

function isHistoryReadableSession(session: AiVaultSession): boolean {
  return isNativeChatSupportedAgent(session.agent)
}

function toHistoryMessage(message: NativeChatMessage): AiVaultHistoryMessage | null {
  const text = message.blocks
    .flatMap((block) => {
      if (block.type === 'text' || block.type === 'tool-result') {
        return [block.type === 'text' ? block.text : block.output]
      }
      return []
    })
    .join('\n')
    .trim()
  if (!text) {
    return null
  }
  return {
    id: message.id.slice(0, AI_VAULT_HISTORY_MESSAGE_ID_MAX_LENGTH),
    role: message.role,
    text: text.slice(0, AI_VAULT_HISTORY_TEXT_MAX_LENGTH),
    timestamp: toHistoryTimestamp(message.timestamp)
  }
}

function toHistoryTimestamp(value: number | null): string | null {
  if (value === null) {
    return null
  }
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString()
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback
  }
  return Math.min(value, fallback)
}
