import type {
  OpenCodeTranscriptForwardPage,
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from '../native-chat/transcript-opencode-sqlite-query'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import { PARSE_TIMEOUT_MS } from './session-scanner-opencode-sqlite-worker-client'

// Why: the native-chat read dispatchers live here, not on the worker client
// class, so the client (FIFO queue, respawn cap, idle teardown) stays under
// the repo's file-size cap. Same request shapes the worker entry serves.

/**
 * Read one native-chat transcript page on the worker.
 * @returns The page, or `null` when the session row does not exist.
 *   Rejects on worker unavailability/timeout/crash.
 */
export async function dispatchOpenCodeNativeChatPage(
  client: OpenCodeSqliteWorkerClient,
  args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeMessageRowId?: number
  }
): Promise<OpenCodeTranscriptPage | null> {
  const value = await client.dispatch(
    {
      kind: 'native-chat-page',
      dbPath: args.dbPath,
      sessionId: args.sessionId,
      limit: args.limit,
      ...(args.beforeMessageRowId !== undefined
        ? { beforeMessageRowId: args.beforeMessageRowId }
        : {})
    },
    PARSE_TIMEOUT_MS
  )
  return value as OpenCodeTranscriptPage | null
}

/**
 * Read the cheap change signal for one session on the worker.
 * @returns The signal, or `null` when the session row does not exist.
 *   Rejects on worker unavailability/timeout/crash.
 */
export async function dispatchOpenCodeNativeChatSignal(
  client: OpenCodeSqliteWorkerClient,
  args: { dbPath: string; sessionId: string }
): Promise<OpenCodeTranscriptSignal | null> {
  const value = await client.dispatch(
    { kind: 'native-chat-signal', dbPath: args.dbPath, sessionId: args.sessionId },
    PARSE_TIMEOUT_MS
  )
  return value as OpenCodeTranscriptSignal | null
}

/**
 * Read the oldest-first messages strictly NEWER than a rowid cursor on the
 * worker — the orchestration worker-read's forward continuation.
 * @returns The page, or `null` when the session row does not exist.
 *   Rejects on worker unavailability/timeout/crash.
 */
export async function dispatchOpenCodeNativeChatPageAfter(
  client: OpenCodeSqliteWorkerClient,
  args: {
    dbPath: string
    sessionId: string
    afterMessageRowId: number
    limit: number
    upToMessageRowId?: number
  }
): Promise<OpenCodeTranscriptForwardPage | null> {
  const value = await client.dispatch(
    {
      kind: 'native-chat-page-after',
      dbPath: args.dbPath,
      sessionId: args.sessionId,
      afterMessageRowId: args.afterMessageRowId,
      limit: args.limit,
      ...(args.upToMessageRowId !== undefined ? { upToMessageRowId: args.upToMessageRowId } : {})
    },
    PARSE_TIMEOUT_MS
  )
  return value as OpenCodeTranscriptForwardPage | null
}
