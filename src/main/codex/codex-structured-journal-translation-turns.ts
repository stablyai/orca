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
import { resolveAgentJournalTurnRowWrite } from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** Room for what a Codex turn row holds beyond its lifecycle: a context report with no breakdown.
 *  The shared bound allows a full breakdown, which a history restore writing every turn would overrun. */
const CODEX_TURN_ROW_KEPT_BYTES = 1_024

function codexTurnRowReservedBytes(
  identity: AgentJournalItemIdentity,
  lifecycle: AgentJournalTurnItem
): number {
  return estimateStructuredAgentSessionItemBytes(identity, lifecycle) + CODEX_TURN_ROW_KEPT_BYTES
}

/** A turn's lifecycle over its row as the journal holds it, so the row keeps every field this
 *  writer does not own, such as its context facts. */
export function reviseCodexTurnRow(
  journal: StructuredAgentSessionRevisionJournal,
  identity: AgentJournalItemIdentity,
  lifecycle: AgentJournalTurnItem
): AgentJournalTurnItem {
  const reservedBytes = codexTurnRowReservedBytes(identity, lifecycle)
  return (
    resolveAgentJournalTurnRowWrite(journal, { identity }, { lifecycle }, reservedBytes)?.body ??
    lifecycle
  )
}

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

/** Maps a `turn/completed` status, live or restored. Only `interrupted` is a stop;
 *  a failed turn completed, and `codexTurnOutcome` says it failed. */
export function codexTurnLifecycleState(
  status: string | null
): Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'> {
  return status === 'interrupted' ? 'interrupted' : 'completed'
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
  let admission = ADMITTED
  if (input.sink.tryReviseResolvedItem) {
    admission = input.sink.tryReviseResolvedItem(
      codexTurnRowReservedBytes(identity, body),
      (journal) => ({ identity, body: reviseCodexTurnRow(journal, identity, body) }),
      appendOptions
    )
  } else if (input.sink.tryAppendItem) {
    admission = input.sink.tryAppendItem(identity, body, appendOptions)
  } else {
    input.sink.appendItem(identity, body, appendOptions)
  }
  if (!admission.accepted) {
    return admission
  }
  // Keyed apart, so a completion's publication never replaces a start one still waiting to run.
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
