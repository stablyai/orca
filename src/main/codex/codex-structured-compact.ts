import type { CodexSession } from './codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'

/** The ack is the receipt; the translator ends the command from the turn it opens. */
export async function compactCodexStructuredSession(
  session: CodexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0],
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['compact']>> {
  session.translator?.beginCommand(input.command)
  try {
    await session.connection.request(
      'thread/compact/start',
      { threadId: session.threadId },
      { timeoutMs: timeoutMs }
    )
    return { state: 'accepted', providerIdentity: null }
  } catch (error) {
    session.translator?.forgetCommand(input.command.turnId)
    if (isCodexAppServerRequestError(error)) {
      // Codex's own words, when it gave any, are the one part of the error a person can use.
      return {
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) })
        )
      }
    }
    throw error
  }
}
