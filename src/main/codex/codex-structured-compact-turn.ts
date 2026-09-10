import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/**
 * Runs `thread/compact/start` under the shared compaction bookkeeping.
 *
 * A provider-side refusal is degraded to a result the caller can report, because a compaction the
 * provider declined is an answer — not a transport failure the session should be torn down over.
 */
export function compactCodexSession(
  session: CodexSession,
  compactions: StructuredSessionCompaction,
  turnCancellation: CodexStructuredTurnCancellation,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0],
  requestTimeoutMs: number | undefined
): ReturnType<NonNullable<StructuredAgentSessionAdapter['compact']>> {
  return compactions.run(
    input.sessionId,
    session.threadId,
    async () => {
      await turnCancellation.captureBaseline(session)
      return session.connection
        .request(
          'thread/compact/start',
          { threadId: session.threadId },
          { timeoutMs: requestTimeoutMs }
        )
        .catch((error) => {
          if (isCodexAppServerRequestError(error)) {
            return { error: error.message }
          }
          throw error
        })
    },
    input.onLateResult,
    input.turnId
  )
}
