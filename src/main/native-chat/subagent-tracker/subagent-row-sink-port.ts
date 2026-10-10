// A subagent group's row written straight to the session's journal sink.

import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/structured-agent-session-event-sink'
import type { SubagentRowPort } from './subagent-tracker-types'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/**
 * Deliberately ROOT: the row is written from a child's frame but describes the PARENT's children,
 * so it is the session's own agent reporting what it spawned. Stamping it as a child's would hide
 * the roster from the very row that owns it.
 */
export function subagentRowSinkPort(
  sink: StructuredAgentSessionEventSink,
  identityFor: (groupId: string) => AgentJournalItemIdentity
): SubagentRowPort<AgentJournalTurnScope> {
  return {
    write: (group, { body }) => {
      const identity = identityFor(group.groupId)
      const admission = body
        ? (sink.tryAppendItem?.(identity, body, { turnScope: group.placement }) ??
          (sink.appendItem(identity, body, { turnScope: group.placement }), ADMITTED))
        : (sink.tryAppendTombstone?.(identity) ?? (sink.appendTombstone(identity), ADMITTED))
      if (!admission.accepted) {
        return admission
      }
      return sink.tryPublish?.() ?? (sink.publish(), ADMITTED)
    }
  }
}
