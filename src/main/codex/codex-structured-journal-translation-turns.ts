import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem,
  AgentJournalTurnLifecycle,
  AgentJournalTurnLifecycleState
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

/** `turn/completed` is Codex's only turn-end notification; a missing status is a clean finish. */
export function codexTurnLifecycleState(
  status: string | null
): Extract<AgentJournalTurnLifecycleState, 'completed' | 'interrupted'> {
  return status === null || status === 'completed' ? 'completed' : 'interrupted'
}

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: AgentJournalTurnLifecycleState
  startedAt?: number
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
    userItemId: codexTurnUserItemId(input.threadId, input.turnId),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
  })
  // The running row's `ts` is the host's turn-start receipt so clients can anchor a live counter.
  const appendOptions = {
    lifecycle: true,
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
