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

/** One dispatch round-trip; the worker entry returns exactly the value shape
 *  its request kind produces (internal same-thread protocol). */
async function dispatchValue<T>(
  client: OpenCodeSqliteWorkerClient,
  request: Parameters<OpenCodeSqliteWorkerClient['dispatch']>[0]
): Promise<T> {
  const value = await client.dispatch(request, PARSE_TIMEOUT_MS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker entry returns exactly the value shape its request kind produces.
  return value as T
}

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
  return dispatchValue<OpenCodeTranscriptPage | null>(client, {
    kind: 'native-chat-page',
    dbPath: args.dbPath,
    sessionId: args.sessionId,
    limit: args.limit,
    ...(args.beforeMessageRowId !== undefined
      ? { beforeMessageRowId: args.beforeMessageRowId }
      : {})
  })
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
  return dispatchValue<OpenCodeTranscriptSignal | null>(client, {
    kind: 'native-chat-signal',
    dbPath: args.dbPath,
    sessionId: args.sessionId
  })
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
  return dispatchValue<OpenCodeTranscriptForwardPage | null>(client, {
    kind: 'native-chat-page-after',
    dbPath: args.dbPath,
    sessionId: args.sessionId,
    afterMessageRowId: args.afterMessageRowId,
    limit: args.limit,
    ...(args.upToMessageRowId !== undefined ? { upToMessageRowId: args.upToMessageRowId } : {})
  })
}
