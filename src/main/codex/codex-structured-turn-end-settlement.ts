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
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
} & AgentJournalDispatchRejection

function errorDetail(params: unknown): ProviderDiagnostic | undefined {
  const message = readCodexTurnErrorMessage(params)
  return message ? providerDiagnostic(message, 'person') : undefined
}

/** Pre-0.148 unopened turns can end with only a final error; opened turns still send turn/completed. */
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

/** Settle unechoed sends only at turn end, after any failed-turn input persistence. */
export function codexTurnEndRejection(
  end: CodexTurnEnd,
  account?: CodexSession['account']
): AgentJournalDispatchRejection | null {
  // Interrupt clears pending steers and can abort initial-input persistence after 100 ms.
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
  // Successful completion cannot disprove delivery; missing echoes await journal recovery.
  return null
}

/** Record opening before idle status can arrive ahead of turn completion. */
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

/** Unopened turns have no journal record to reference in settlement. */
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
