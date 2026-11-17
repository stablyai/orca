import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionFileCandidate } from '../../session-scanner-types'
import type { OpenCodeSqliteCaptureValue } from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-protocol'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  captureForHost,
  listForHost,
  parseForHost,
  readNativeChatForHost,
  type SqliteCaptureArgs,
  type SqliteListArgs,
  type SqliteParseArgs
} from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'

// Hermes' state.db is read by the same off-thread SQLite reader as OpenCode's stores, WSL guests included.

export const listHermesSqliteSessionsViaWorker = (
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> => listForHost({ ...args, agent: 'hermes' })

export const parseHermesSqliteSessionViaWorker = (
  args: SqliteParseArgs
): Promise<AiVaultSession | null> => parseForHost({ ...args, agent: 'hermes' })

export const captureHermesSqliteSessionViaWorker = (
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> => captureForHost({ ...args, agent: 'hermes' })

/** A Hermes conversation as chat history, for a chat that takes the conversation over. */
export async function readHermesChatTranscriptViaWorker(
  args: { dbPath: string; sessionId: string },
  signal?: AbortSignal
): Promise<NativeChatMessage[] | null> {
  const value = await readNativeChatForHost({ ...args, kind: 'hermes-history' }, signal)
  if (value !== null && !Array.isArray(value)) {
    throw new Error('Invalid Hermes transcript')
  }
  return value
}

/** Whether a Hermes store holds the session, without reading its messages. */
export async function hasHermesSessionViaWorker(args: {
  dbPath: string
  sessionId: string
}): Promise<boolean> {
  const value = await readNativeChatForHost({ ...args, kind: 'hermes-exists' })
  if (value === null || !('exists' in value)) {
    throw new Error('Invalid Hermes session check')
  }
  return value.exists
}
