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

/** Reserve for Codex's context report; the larger shared bound would overrun history restores. */
const CODEX_TURN_ROW_KEPT_BYTES = 1_024

function codexTurnRowReservedBytes(
  identity: AgentJournalItemIdentity,
  lifecycle: AgentJournalTurnItem
): number {
  return estimateStructuredAgentSessionItemBytes(identity, lifecycle) + CODEX_TURN_ROW_KEPT_BYTES
}

/** Preserve fields this lifecycle writer does not own, including context usage. */
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

/** Failed turns are completed; codexTurnOutcome carries their failure verdict. */
export function codexTurnLifecycleState(
  status: string | null
): Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'> {
  return status === 'interrupted' ? 'interrupted' : 'completed'
}

/** Missing, unknown or inProgress statuses at turn-end cannot establish a verdict. */
export function codexTurnOutcome(status: string | null): AgentJournalTurnOutcome | null {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'failure'
    case 'interrupted':
      return 'cancellation'
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
  /** Absent means unknown, not success. */
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
  // Anchor live counters to the host's turn-start receipt.
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
  // Keep queued start publications separate from completion publications.
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
