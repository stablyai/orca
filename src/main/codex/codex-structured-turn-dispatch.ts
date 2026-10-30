import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type {
  AgentJournalMessageItem,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  codexAnsweredTurn,
  codexDispatchRejection,
  codexTurnEndRejection
} from './codex-structured-turn-end-settlement'
import { startCodexTurn, type CodexTurnHost } from './codex-structured-turn-start'

/** Replies establish admission; exact echoes establish identity. Timeouts cannot disprove delivery. */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    requestedAt?: number
    turnOptions?: Readonly<Record<string, string>>
    signal?: AbortSignal
    isCurrent?: () => boolean
    admitFreshInput?: StructuredAgentSessionAdmitFreshInput
  },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  let answer: { turnId: string | null; via: AgentJournalTurnJoin } | false
  // Capture wire order at reply receipt, before async continuations run.
  let answeredAt: number | undefined
  const onReply = (): void => {
    answeredAt = session.dispatchEchoes.tick()
  }
  let receivedOutcome: AgentSessionDispatchOutcome | undefined
  const settleAnswer = (answer: {
    turnId: string | null
    via: AgentJournalTurnJoin
  }): AgentSessionDispatchOutcome => {
    // An answer read after the turn it names already ended is settled by that end.
    if (!answer.turnId) {
      session.dispatchEchoes.answered(
        input.clientMessageId,
        answeredAt ?? session.dispatchEchoes.tick()
      )
    }
    const endedFirst = answer.turnId
      ? session.dispatchEchoes.bindTurn(
          input.clientMessageId,
          session.threadId,
          answer.turnId,
          answer.via,
          answeredAt
        )
      : null
    const rejection = endedFirst ? codexTurnEndRejection(endedFirst, session.account) : null
    return rejection && answer.turnId
      ? {
          state: 'rejected',
          ...codexAnsweredTurn(session, input.sessionId, answer.turnId, answer.via),
          ...rejection
        }
      : { state: 'admitted', ranOptions: codexRanOptions(session) }
  }
  const onStarted = (answer: { turnId: string | null; via: AgentJournalTurnJoin }): void => {
    receivedOutcome = settleAnswer(answer)
  }
  try {
    answer = await startCodexTurn(session, { ...input, timeoutMs, onReply, onStarted })
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      // Codex answered and declined, so no echo for this write can arrive.
      session.dispatchEchoes.disarm(input.clientMessageId)
      // Declined requests recorded no input; carried stopped messages remain owed.
      return {
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnosticOf(error),
            neverReachedAgent: true
          })
        )
      }
    }
    // Transport failure may follow a successful write; keep correlation for a later echo.
    session.dispatchEchoes.answered(
      input.clientMessageId,
      answeredAt ?? session.dispatchEchoes.tick()
    )
    throw error
  }
  if (!answer) {
    return { state: 'rejected', ...codexDispatchRejection(agentSessionFailureFact('queueFull')) }
  }
  return receivedOutcome ?? settleAnswer(answer)
}

/** Steers retain running-turn options; starts use request overrides over thread defaults. */
function codexRanOptions(session: CodexTurnHost): Record<string, string> {
  return { ...session.appliedTurnOptions }
}
