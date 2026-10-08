import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'

/** The summary fields the record owns, read the same way for a live row and a restored one. */
export function structuredAgentSessionRecordSummaryFields(
  record: AgentSessionRecord | null
): Pick<
  AgentSessionStatusSummary,
  'rewindBlockedReason' | 'model' | 'providerSession' | 'launchDirectory' | 'conversationName'
> {
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  return {
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...(record?.conversationName ? { conversationName: record.conversationName } : {})
  }
}

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  journal,
  record,
  state,
  stopping,
  childWork,
  now
}: {
  sessionId: string
  session: {
    params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
    child?: Pick<StructuredAgentSessionProviderChild, 'phase'> | null
  }
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  state: StructuredAgentSessionStatusState
  /** A person's Stop is still ending the work it stopped. */
  stopping: boolean
  childWork: Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'>
  now: () => number
}): AgentSessionStatusSummary {
  const projected = state.summary
  return {
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider,
    ...(session.child
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: session.child.phase
        }
      : {}),
    ...projected,
    // Only a working session is still being stopped; any other status already ended that work.
    ...(stopping && projected.status === 'working' ? { stopping: true as const } : {}),
    ...structuredAgentSessionRecordSummaryFields(record),
    ...childWork,
    updatedAt: journal.lastActivityAt() || now()
  }
}
