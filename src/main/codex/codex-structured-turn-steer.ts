import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { turnInputFor } from './codex-structured-turn-start'

export async function steerCodexTurn(
  sessionId: string,
  session: CodexSession,
  input: { clientMessageId: string; body: AgentJournalMessageItem; turnId: string },
  timeoutMs?: number
): Promise<AgentSessionDispatchOutcome> {
  let response: unknown
  try {
    response = await session.connection.request(
      'turn/steer',
      {
        threadId: session.threadId,
        input: turnInputFor(input.body),
        expectedTurnId: input.turnId,
        clientUserMessageId: input.clientMessageId
      },
      { timeoutMs }
    )
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      return { state: 'rejected', reason: error.message }
    }
    throw error
  }
  if (readCodexTurnId(response) !== input.turnId) {
    return { state: 'rejected', reason: 'codex_steer_turn_mismatch' }
  }
  return {
    state: 'accepted',
    providerIdentity: {
      provider: 'legacy',
      agent: 'codex',
      sessionId,
      recordId: `user:${input.clientMessageId}`,
      turn: { turnId: input.turnId }
    }
  }
}
