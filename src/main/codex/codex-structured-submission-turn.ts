import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexSession } from './codex-structured-session-state'

type SubmissionTurnObserver = NonNullable<StructuredAgentSessionAdapter['observeSubmissionTurn']>

/** Admission binds the request before its user echo; an absent binding proves no exit. */
export function observeCodexSubmissionTurn(
  session: CodexSession | undefined,
  input: Parameters<SubmissionTurnObserver>[0]
): ReturnType<SubmissionTurnObserver> {
  if (!session) {
    return { verdict: 'unverifiable' }
  }
  if (session.ended || session.exitObservedAt !== undefined || session.fence !== input.fence) {
    return { verdict: 'exited' }
  }
  const turn = session.dispatchEchoes.boundTurn(input.clientMessageId)
  if (!turn || turn.threadId !== session.threadId) {
    return { verdict: 'unverifiable' }
  }
  return turn.ended || session.abortedTurnIds?.has(turn.turnId)
    ? { verdict: 'exited' }
    : { verdict: 'live', turnId: turn.turnId }
}

/** The adapter's observer over its own sessions. */
export function codexSubmissionTurnObserver(
  sessions: ReadonlyMap<string, CodexSession>
): SubmissionTurnObserver {
  return (input) => observeCodexSubmissionTurn(sessions.get(input.sessionId), input)
}
