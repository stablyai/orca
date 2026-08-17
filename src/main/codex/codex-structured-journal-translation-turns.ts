import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function codexTerminalTurnLifecycle(
  turnId: string,
  outcome: 'completed' | 'failed' | 'interrupted'
): AgentJournalItemBody {
  const text =
    outcome === 'completed' ? 'Completed' : outcome === 'interrupted' ? 'Interrupted' : 'Failed'
  return { kind: 'status', text, turnLifecycle: { turnId, state: 'completed', outcome } }
}

export function publishCodexTurnLifecycle(input: {
  sink: StructuredAgentSessionEventSink
  primaryThreadId: string | null
  sessionId: string
  threadId: string
  turnId: string
  state: 'running'
}): StructuredAgentSessionSinkAdmission {
  if (input.primaryThreadId !== input.threadId) {
    return ADMITTED
  }
  const identity = {
    provider: 'legacy' as const,
    agent: 'codex' as const,
    sessionId: input.sessionId,
    recordId: `turn-lifecycle:${input.turnId}`
  }
  const admission = input.sink.tryAppendItem
    ? input.sink.tryAppendItem(
        identity,
        {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: input.turnId, state: input.state }
        },
        { lifecycle: true }
      )
    : (input.sink.appendItem(
        identity,
        {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: input.turnId, state: input.state }
        },
        { lifecycle: true }
      ),
      ADMITTED)
  if (!admission.accepted) {
    return admission
  }
  if (input.sink.tryPublish) {
    return input.sink.tryPublish({ lifecycle: true })
  }
  input.sink.publish({ lifecycle: true })
  return ADMITTED
}
