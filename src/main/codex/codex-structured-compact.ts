import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import type { CodexSession } from './codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/**
 * Runs a compaction against the app-server, through the shared compaction
 * bookkeeping that dedupes and settles late results.
 *
 * Lives outside the adapter for the same reason the background-terminal and
 * rewind surfaces do: the adapter is a delegation hub, and a method with a body
 * this size is the odd one out rather than the norm.
 */
export function compactCodexSession(args: {
  compactions: StructuredSessionCompaction
  turnCancellation: CodexStructuredTurnCancellation
  session: CodexSession
  requestTimeoutMs: number | undefined
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0]
}): ReturnType<StructuredSessionCompaction['run']> {
  const { compactions, input, requestTimeoutMs, session, turnCancellation } = args
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
          // A refusal is a compaction outcome, not a transport failure: report
          // it back rather than tearing down the session.
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
