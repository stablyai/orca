import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  journalClaudeFullAccessRefusal,
  type ClaudePermissionNoticeSession
} from '../permissions/claude-full-access-refusal-notice'

export function claudePermissionNoticeDelivery(
  sink: StructuredAgentSessionEventSink,
  session: () => ClaudePermissionNoticeSession | null | undefined,
  turnScope: () => AgentJournalTurnScope,
  ready: () => boolean
) {
  let paused = false
  let dirty = false
  const reconcile = () => {
    const admission = journalClaudeFullAccessRefusal(sink, session(), turnScope())
    dirty = !admission.accepted && admission.reason === 'backpressure'
    paused ||= dirty
    return admission
  }
  return {
    recheckPermissionNotice: () => {
      if (!ready()) {
        return
      }
      if (paused) {
        dirty = true
        return
      }
      reconcile()
    },
    setPermissionNoticePaused: (value: boolean) => {
      paused = value
    },
    retryPermissionNotice: (): StructuredAgentSessionSinkAdmission =>
      ready() && dirty && !paused ? reconcile() : { accepted: true },
    dropPending: () => {
      dirty = false
    }
  }
}
