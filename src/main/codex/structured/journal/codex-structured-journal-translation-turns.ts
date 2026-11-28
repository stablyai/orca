import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalTurnJoin,
  type AgentJournalTurnItem,
  type AgentJournalTurnLifecycleState
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnOutcome } from '../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalTurnBody as codexTurnLifecycleBody } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { CODEX_USER_MESSAGE_ORDINAL } from './codex-turn-ordinals'
import type { CodexDispatchEchoes } from '../turns/codex-structured-dispatch-echo'
import { resolveAgentJournalTurnRowWrite } from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { JournalTimelineView } from '../../../native-chat/agent-session-journal/writing/journal-timeline-view'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** Reserve for Codex's context report; the larger shared bound would overrun history restores. */
export const CODEX_TURN_ROW_KEPT_BYTES = 1_024

function codexTurnRowReservedBytes(
  identity: AgentJournalItemIdentity,
  lifecycle: AgentJournalTurnItem
): number {
  return estimateStructuredAgentSessionItemBytes(identity, lifecycle) + CODEX_TURN_ROW_KEPT_BYTES
}

/** Preserve fields this lifecycle writer does not own, including context usage. */
export function reviseCodexTurnRow(
  view: Pick<JournalTimelineView, 'itemBody'>,
  identity: AgentJournalItemIdentity,
  lifecycle: AgentJournalTurnItem
): AgentJournalTurnItem {
  const reservedBytes = codexTurnRowReservedBytes(identity, lifecycle)
  // A named lifecycle revision reads only its own row.
  const own = { itemBody: view.itemBody, newestTurn: () => null, contextWindowHeld: () => false }
  return (
    resolveAgentJournalTurnRowWrite(own, { identity }, { lifecycle }, reservedBytes)?.body ??
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

/** How the provider took a send, read at its echo: a turn start Codex steered into a turn already
 *  running, or one another send opened, joined that turn. Read before the send settles. */
export function codexEchoVia(
  echoes: Pick<CodexDispatchEchoes, 'sentVia' | 'echoedVia'>,
  clientMessageId: string,
  providerIdentity: AgentJournalItemIdentity
): AgentJournalTurnJoin | null {
  return providerIdentity.provider === 'codex'
    ? echoes.echoedVia(clientMessageId, providerIdentity.threadId, providerIdentity.turnId)
    : echoes.sentVia(clientMessageId)
}

/** The settled send a provider echo names, with how it was taken (`codexEchoVia`). */
export function codexEchoedSend(
  sessionId: string,
  clientMessageId: string,
  providerIdentity: AgentJournalItemIdentity,
  echoes: Pick<CodexDispatchEchoes, 'sentVia' | 'echoedVia'>
) {
  const via = codexEchoVia(echoes, clientMessageId, providerIdentity)
  return { sessionId, clientMessageId, ...codexAcceptedSend(sessionId, providerIdentity, via) }
}

/** A send written into a running turn joined the turn its echo names, which another send opened. */
export function codexAcceptedSend(
  sessionId: string,
  providerIdentity: AgentJournalItemIdentity,
  via: AgentJournalTurnJoin | null
): {
  providerIdentity: AgentJournalItemIdentity
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
} {
  return providerIdentity.provider === 'codex' && via === 'steer'
    ? {
        providerIdentity,
        answeredInTurn: {
          turn: codexTurnLifecycleIdentity(sessionId, providerIdentity.turnId),
          via
        }
      }
    : { providerIdentity }
}

export function codexTurnUserItemId(threadId: string, turnId: string): string {
  return agentJournalItemKey({
    provider: 'codex',
    threadId,
    turnId,
    ordinal: CODEX_USER_MESSAGE_ORDINAL
  })
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
      { kind: 'turn-row', target: { identity }, write: { lifecycle: body } },
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
