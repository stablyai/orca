import { structuredAgentSessionRuntimePermission } from './structured-agent-session-ran-options'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import type {
  StructuredAgentSessionProviderChild,
  StructuredChatNamingFailure
} from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type {
  StructuredAgentSessionStatusFeedDeps,
  StatusPublication
} from './structured-agent-session-status-feed-deps'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  journal,
  record,
  state,
  stopping,
  starting,
  childWork,
  namingFailure,
  now
}: {
  sessionId: string
  session: {
    params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
    child?: StructuredAgentSessionProviderChild | null
    restartResume?: AgentSessionStatusSummary['restartResume']
  }
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  state: StructuredAgentSessionStatusState
  starting?: boolean
  stopping: boolean
  childWork: Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'>
  namingFailure: StructuredChatNamingFailure | undefined
  now: () => number
}): AgentSessionStatusSummary {
  const projected = state.summary
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // Acknowledged record options remain authoritative across model switches.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  const permissionMode = record?.permissionMode
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  return {
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider,
    ...(session.child || starting
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: session.child?.phase ?? 'starting'
        }
      : {}),
    ...(session.restartResume ? { restartResume: { phase: session.restartResume.phase } } : {}),
    ...projected,
    runtimePermission: structuredAgentSessionRuntimePermission(session.child ?? undefined),
    // Only a working session is still being stopped; any other status already ended that work.
    ...(stopping && projected.status === 'working' ? { stopping: true as const } : {}),
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(isAgentChatPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...childWork,
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...structuredSummaryConversationNaming(record, namingFailure),
    ...(typeof record?.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {}),
    updatedAt: journal.lastActivityAt() || now()
  }
}

/** The record's name, and the failure to replace it only while that is still the name. */
export function structuredSummaryConversationNaming(
  record: AgentSessionRecord | null,
  failure: StructuredChatNamingFailure | undefined
): Pick<AgentSessionStatusSummary, 'conversationName' | 'namingError'> {
  const name = record?.conversationName
  if (!name) {
    return {}
  }
  return failure?.forName === name
    ? {
        conversationName: name,
        namingError: { message: failure.message, failedAt: failure.failedAt }
      }
    : { conversationName: name }
}

export function renamedStructuredStatusSummary(
  previous: AgentSessionStatusSummary,
  deps: Pick<StructuredAgentSessionStatusFeedDeps, 'getRecord' | 'namingFailure'>,
  sessionId: string
): AgentSessionStatusSummary | null {
  const record = deps.getRecord(sessionId)
  const { conversationName: _name, namingError: _error, sleptAt: _sleptAt, ...rest } = previous
  const summary = {
    ...rest,
    ...structuredSummaryConversationNaming(record, deps.namingFailure?.(sessionId)),
    ...(typeof record?.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {})
  }
  return structuredStatusSummariesEqual(previous, summary) ? null : summary
}

export function retainedStructuredStatusSummaries(
  publications: Iterable<StatusPublication>,
  deps: StructuredAgentSessionStatusFeedDeps
): AgentSessionStatusSummary[] {
  return [...publications].map(
    ({ summary }) => renamedStructuredStatusSummary(summary, deps, summary.sessionId) ?? summary
  )
}
