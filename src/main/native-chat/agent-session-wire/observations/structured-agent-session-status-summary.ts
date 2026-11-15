import { isAgentSessionInteractionMode } from '../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import { structuredAgentSessionRuntimePermission } from '../options/structured-agent-session-ran-options'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import {
  normalizeOptionalField,
  AGENT_MODEL_MAX_LENGTH
} from '../../../../shared/agent-status/contracts/agent-status-field-normalization'

import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import type {
  StructuredAgentSessionProviderChild,
  StructuredChatNamingFailure
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from '../publication/history/structured-agent-session-history-result'
import { agentSessionPinnedLaunchDirectory } from '../../../runtime/agent-session/records/agent-session-record-launch-directory'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type {
  StructuredAgentSessionStatusFeedDeps,
  StatusPublication
} from './structured-agent-session-status-feed-deps'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'
import { structuredAgentRuntimeMetadata } from '../../../runtime/agent-session/installation/structured-agent-runtime-metadata'

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  lastActivityAt,
  record,
  state,
  stopping,
  starting,
  usageLimitContinue,
  childWork,
  namingFailure,
  now
}: {
  sessionId: string
  session: {
    params: {
      location: AgentSessionConversationView['location']
      provider: AgentSessionConversationView['provider']
    }
    child?: StructuredAgentSessionProviderChild | null
    restartResume?: AgentSessionStatusSummary['restartResume']
  }
  lastActivityAt: number
  record: AgentSessionConversationView | null
  state: StructuredAgentSessionStatusState
  starting?: boolean
  usageLimitContinue?: AgentSessionStatusSummary['usageLimitContinue']
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
  // Published so another device's pick moves the client's option stamp.
  const effort = record?.options?.effort
  const fastMode = record?.options?.fastMode
  const serviceTier = record?.options?.serviceTier
  const interactionMode = record?.options?.interactionMode
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  return {
    sessionId,
    ...(usageLimitContinue ? { usageLimitContinue } : {}),
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
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(isAgentSessionInteractionMode(interactionMode) ? { interactionMode } : {}),
    ...childWork,
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...structuredSummaryHostProgram(record),
    ...structuredSummaryConversationNaming(record, namingFailure),
    ...(typeof record?.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {}),
    updatedAt: lastActivityAt || now()
  }
}

/** Marks chats whose pinned account runs a host program, which need no managed install. */
export function structuredSummaryHostProgram(
  record: Pick<AgentSessionConversationView, 'provider' | 'accountHome'> | null
): Pick<AgentSessionStatusSummary, 'hostProgram'> {
  return record &&
    structuredAgentRuntimeMetadata(record.provider)?.definition.runsHostProgram?.(
      record.accountHome
    )
    ? { hostProgram: true }
    : {}
}

type StructuredSummaryNaming = Pick<
  AgentSessionStatusSummary,
  'conversationName' | 'namingError' | 'conversationNameSource' | 'forkedFrom'
>

/** The record's name, its provenance, and the failure to replace it only while that is still the
 *  name. `forkedFrom` is always present for a record, so clients read the frame as authoritative. */
export function structuredSummaryConversationNaming(
  record: AgentSessionConversationView | null,
  failure: StructuredChatNamingFailure | undefined
): StructuredSummaryNaming {
  if (!record) {
    return {}
  }
  const name = record.conversationName
  const provenance: StructuredSummaryNaming = {
    forkedFrom: record.forkedFrom
      ? {
          sessionId: record.forkedFrom.sessionId,
          ...(record.forkedFrom.plainName ? { plainName: true as const } : {})
        }
      : null,
    ...(record.conversationNameSource === 'user' ? { conversationNameSource: 'user' as const } : {})
  }
  if (!name) {
    return provenance
  }
  return failure?.forName === name
    ? {
        conversationName: name,
        ...provenance,
        namingError: {
          message: failure.message,
          failedAt: failure.failedAt,
          ...(failure.messageCode ? { messageCode: failure.messageCode } : {})
        }
      }
    : { conversationName: name, ...provenance }
}

export function renamedStructuredStatusSummary(
  previous: AgentSessionStatusSummary,
  deps: Pick<StructuredAgentSessionStatusFeedDeps, 'getConversation' | 'namingFailure'>,
  sessionId: string
): AgentSessionStatusSummary | null {
  const record = deps.getConversation(sessionId)
  const {
    conversationName: _name,
    namingError: _error,
    conversationNameSource: _source,
    forkedFrom: _forkedFrom,
    sleptAt: _sleptAt,
    ...rest
  } = previous
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

export function releasedStructuredStatusSummary(
  previous: AgentSessionStatusSummary
): AgentSessionStatusSummary {
  const {
    hostExecutionOwned: _hostExecutionOwned,
    hostExecutionPhase: _hostExecutionPhase,
    stopping: _stopping,
    restartResume: _restartResume,
    reportedModel: _reportedModel,
    ...retained
  } = previous
  return { ...retained, runtimePermission: null }
}
