import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnItem,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnLifecycleState,
  type AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { CODEX_USER_MESSAGE_ORDINAL } from './codex-turn-ordinals'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function codexTurnLifecycleIdentity(
  sessionId: string,
  turnId: string
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'codex',
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

/** Provider key of the user message that opened the turn; deterministic, so never remembered. */
export function codexTurnUserItemId(threadId: string, turnId: string): string {
  return agentJournalItemKey({
    provider: 'codex',
    threadId,
    turnId,
    ordinal: CODEX_USER_MESSAGE_ORDINAL
  })
}

export function codexTurnLifecycleBody(
  turnLifecycle: AgentJournalTurnLifecycle
): AgentJournalTurnItem {
  return agentJournalTurnBody(turnLifecycle)
}

/** Maps a `turn/completed` status; a missing one is a clean finish. A terminal
 *  `error` also ends a turn and names its own outcome rather than coming here. */
export function codexTurnLifecycleState(
  status: string | null
): Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'> {
  return status === null || status === 'completed' ? 'completed' : 'interrupted'
}

/**
 * Codex's own verdict on a turn, or null when this host cannot place one.
 *
 * `TurnStatus` in the app-server protocol is `completed | interrupted | failed |
 * inProgress` and `status` is REQUIRED on every `Turn`, on the live notification
 * and in resumed history alike. So a missing or unrecognised status is a payload
 * this host did not get, not a clean finish — unlike `codexTurnLifecycleState`,
 * which still has to name a terminal lifecycle arm for the row. `inProgress` on
 * a turn-end contradicts itself and is no verdict either.
 */
export function codexTurnOutcome(status: string | null): AgentJournalTurnOutcome | null {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'failure'
    case 'interrupted':
      return 'cancellation'
    // The fourth protocol arm, plus the two shapes that are no verdict at all.
    case 'inProgress':
    case null:
    default:
      return null
  }
}

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: AgentJournalTurnLifecycleState
  /** Absent whenever Codex named no verdict, which reads as unknown. */
  outcome?: AgentJournalTurnOutcome
  userItemId?: string
  startedAt?: number
  requestedAt?: number
  completedAt?: number
  durationMs?: number
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId) {
    return ADMITTED
  }
  const identity = codexTurnLifecycleIdentity(input.sessionId, input.turnId)
  const body = codexTurnLifecycleBody({
    turnId: input.turnId,
    state: input.state,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    userItemId: input.userItemId ?? codexTurnUserItemId(input.threadId, input.turnId),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.requestedAt !== undefined ? { requestedAt: input.requestedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
  })
  // The running row's `ts` is the host's turn-start receipt so clients can anchor a live counter.
  const appendOptions = {
    lifecycle: true,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    ...(input.state === 'running' && input.startedAt !== undefined
      ? { observedAt: input.startedAt }
      : {})
  }
  if (input.sink.tryAppendItem) {
    const admission = input.sink.tryAppendItem(identity, body, appendOptions)
    if (!admission.accepted) {
      return admission
    }
  } else {
    input.sink.appendItem(identity, body, appendOptions)
  }
  // Preserve first-work evidence when completion arrives before the journal drains.
  const publishOptions = {
    lifecycle: true,
    ...(input.state === 'running'
      ? { coalescingKey: `turn-start:${input.sessionId}:${input.turnId}` }
      : {})
  }
  if (input.sink.tryPublish) {
    return input.sink.tryPublish(publishOptions)
  }
  input.sink.publish(publishOptions)
  return ADMITTED
}
