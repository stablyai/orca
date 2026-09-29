// A send Codex answered into a turn that then ended without echoing it. Codex clears
// a turn's pending input when it is interrupted, so that send never reached the model
// and is withdrawn, as a Stop's host-side withdrawal is. Any other end records pending
// input before `turn/completed`, a failed turn after its `error` frame, so only that
// frame settles: a failed turn that never echoed the send refused it, in Codex's words,
// and a completed one leaves it to the translator's turn-over, which settles it in doubt.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type ProviderDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import type { CodexTurnEnd } from './codex-structured-dispatch-echo'
import type { CodexSession } from './codex-structured-session-state'
import {
  readCodexThreadId,
  readCodexTurnErrorMessage,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'

/** A message Codex rejected, in the words that name Codex and its legacy markers. */
export function codexDispatchRejection(
  failure: SubmissionRejectionFact
): AgentJournalDispatchRejection {
  return agentSessionFailureWords(failure, {
    surface: 'rejection',
    agentName: TUI_AGENT_DISPLAY_NAMES.codex,
    provider: 'codex'
  })
}

export type CodexTurnEndSettlement = {
  clientMessageId: string
  state: 'rejected'
} & AgentJournalDispatchRejection

function errorDetail(params: unknown): ProviderDiagnostic | undefined {
  const message = readCodexTurnErrorMessage(params)
  return message ? providerDiagnostic(message, 'person') : undefined
}

/** The end a primary-thread notification reports for its turn, or null for any other frame. */
export function readCodexTurnEnd(method: string, params: unknown): CodexTurnEnd | null {
  if (method !== 'turn/completed') {
    return null
  }
  const status = readCodexTurnStatus(params)
  if (status === 'interrupted') {
    return { status: 'interrupted' }
  }
  if (status === 'failed') {
    const detail = errorDetail(params)
    return { status: 'failed', ...(detail ? { detail } : {}) }
  }
  return { status: 'completed' }
}

/** How an ended turn settles a send it never echoed; null leaves the send to its echo. */
export function codexTurnEndRejection(end: CodexTurnEnd): AgentJournalDispatchRejection | null {
  if (end.status === 'interrupted') {
    return agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  }
  if (end.status === 'failed') {
    return codexDispatchRejection(
      agentSessionFailureFact('providerRejected', end.detail ? { detail: end.detail } : {})
    )
  }
  return null
}

/** Settles the sends bound to the turn this admitted notification ended. */
export function settleCodexSendsInEndedTurn(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown,
  settle: (settlement: CodexTurnEndSettlement) => void
): void {
  const turnId = readCodexTurnId(params)
  const end = readCodexTurnEnd(method, params)
  if (!turnId || !end || (readCodexThreadId(params) ?? session.threadId) !== session.threadId) {
    return
  }
  const rejection = codexTurnEndRejection(end)
  for (const clientMessageId of session.dispatchEchoes.endTurn(session.threadId, turnId, end)) {
    if (rejection) {
      settle({ clientMessageId, state: 'rejected', ...rejection })
    }
  }
}
