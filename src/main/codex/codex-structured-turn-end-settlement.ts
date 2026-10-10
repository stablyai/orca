// A send Codex answered into a turn that then ended without echoing it. On an interrupt, a
// steered send waits in Codex's pending input, which the interrupt clears; a send that opened the
// turn is saved as the turn cancels, but Codex hard-aborts that save after 100 ms, so it is lost
// or reaches only the model's context, and the thread history shows no user message either way.
// So it is withdrawn, as a Stop's host-side withdrawal is. Any other end records pending
// input before `turn/completed`, a failed turn after its `error` frame, so only that
// frame settles: a failed turn that never echoed the send refused it, in Codex's words,
// and a completed one leaves it pending for the journal's recovery on exit. A turn Codex never
// opened has no `turn/completed`: before 0.148 its final `error` is its end (`unopenedTurnFailure`).

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
import type { AgentJournalAnsweredTurnIdentity } from '../../shared/agent-session-journal-types'
import type { CodexTurnEnd } from './codex-structured-dispatch-echo'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import {
  readCodexThreadId,
  readCodexTurnErrorMessage,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { codexAuthenticationFailure } from './codex-authentication-failure'

/** A message Codex rejected, in the words that name Codex and its legacy markers. */
export function codexDispatchRejection(
  failure: SubmissionRejectionFact,
  account?: CodexSession['account']
): AgentJournalDispatchRejection {
  return agentSessionFailureWords(
    { ...failure, ...(account ? { account } : {}) },
    {
      surface: 'rejection',
      agentName: TUI_AGENT_DISPLAY_NAMES.codex,
      provider: 'codex'
    }
  )
}

export type CodexTurnEndSettlement = {
  clientMessageId: string
  state: 'rejected'
  /** The turn Codex answered the send into, whose end settled it, and how the send joined it. */
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
} & AgentJournalDispatchRejection

function errorDetail(params: unknown): ProviderDiagnostic | undefined {
  const message = readCodexTurnErrorMessage(params)
  return message ? providerDiagnostic(message, 'person') : undefined
}

/** A final `error` naming a turn Codex never opened: before 0.148 that is the only end such a
 *  turn reports. One it opened still reports its own `turn/completed`. */
function unopenedTurnFailure(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown,
  turnId: string
): CodexTurnEnd | null {
  if (
    method !== 'error' ||
    readCodexJournalRecord(params).willRetry !== false ||
    session.dispatchEchoes.hasOpened(session.threadId, turnId)
  ) {
    return null
  }
  const message = readCodexJournalRecord(readCodexJournalRecord(params).error).message
  const detail =
    typeof message === 'string' && message ? providerDiagnostic(message, 'person') : undefined
  const auth = codexAuthenticationFailure(params)
  return {
    status: 'failed',
    ...(auth ? { notSignedIn: true, detail: auth.detail } : detail ? { detail } : {})
  }
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
    const auth = codexAuthenticationFailure({
      error: readCodexJournalRecord(readCodexJournalRecord(params).turn).error
    })
    const detail = errorDetail(params)
    return {
      status: 'failed',
      ...(auth ? { notSignedIn: true, detail: auth.detail } : detail ? { detail } : {})
    }
  }
  return { status: 'completed' }
}

/** How an ended turn settles a send it never echoed; null leaves the send to its echo. */
export function codexTurnEndRejection(
  end: CodexTurnEnd,
  account?: CodexSession['account']
): AgentJournalDispatchRejection | null {
  if (end.status === 'interrupted') {
    return agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  }
  if (end.status === 'failed') {
    return codexDispatchRejection(
      agentSessionFailureFact(end.notSignedIn ? 'notSignedIn' : 'providerRejected', {
        ...(end.detail ? { detail: end.detail } : {}),
        ...(account ? { account } : {})
      })
    )
  }
  return null
}

/** Records a turn Codex opened, ahead of the frames that may report the thread idle before it ends. */
export function noteCodexTurnOpened(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown
): void {
  const turnId = method === 'turn/started' ? readCodexTurnId(params) : null
  if (turnId && (readCodexThreadId(params) ?? session.threadId) === session.threadId) {
    session.dispatchEchoes.opened(session.threadId, turnId)
  }
}

/** Settles the sends bound to the turn this admitted notification ended. */
export function settleCodexSendsInEndedTurn(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes' | 'account'>,
  frame: { sessionId: string; method: string; params: unknown },
  settle: (settlement: CodexTurnEndSettlement) => void
): void {
  const turnId = readCodexTurnId(frame.params)
  const end = turnId
    ? (readCodexTurnEnd(frame.method, frame.params) ??
      unopenedTurnFailure(session, frame.method, frame.params, turnId))
    : null
  if (
    !turnId ||
    !end ||
    (readCodexThreadId(frame.params) ?? session.threadId) !== session.threadId
  ) {
    return
  }
  const rejection = codexTurnEndRejection(end, session.account)
  for (const { clientMessageId, via } of session.dispatchEchoes.endTurn(
    session.threadId,
    turnId,
    end
  )) {
    if (rejection) {
      settle({
        clientMessageId,
        state: 'rejected',
        ...codexAnsweredTurn(session, frame.sessionId, turnId, via),
        ...rejection
      })
    }
  }
}

/** Names the turn a rejected send was answered into only when Codex opened it: one it never
 *  opened has no record in the journal, so the send was answered into no turn. */
export function codexAnsweredTurn(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  sessionId: string,
  turnId: string,
  via: AgentJournalAnsweredTurnIdentity['via']
): { answeredInTurn?: AgentJournalAnsweredTurnIdentity } {
  return session.dispatchEchoes.hasOpened(session.threadId, turnId)
    ? { answeredInTurn: { turn: codexTurnLifecycleIdentity(sessionId, turnId), via } }
    : {}
}
