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
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  journal,
  record,
  state,
  stopping,
  childWork,
  namingFailure,
  now
}: {
  sessionId: string
  session: {
    params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
    child?: Pick<StructuredAgentSessionProviderChild, 'phase'> | null
    restartResume?: AgentSessionStatusSummary['restartResume']
  }
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  state: StructuredAgentSessionStatusState
  /** A person's Stop is still ending the work it stopped. */
  stopping: boolean
  childWork: Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'>
  namingFailure: StructuredChatNamingFailure | undefined
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
    ...(session.restartResume ? { restartResume: { phase: session.restartResume.phase } } : {}),
    ...projected,
    // Only a working session is still being stopped; any other status already ended that work.
    ...(stopping && projected.status === 'working' ? { stopping: true as const } : {}),
    ...structuredSummaryRecordFields(record, namingFailure),
    ...childWork,
    updatedAt: journal.lastActivityAt() || now()
  }
}

/** The row with what only a live host knows taken off: who executes it, and a Stop or restart
 *  action still under way. */
export function withoutLiveExecution(
  summary: AgentSessionStatusSummary
): AgentSessionStatusSummary {
  const {
    hostExecutionOwned: _hostExecutionOwned,
    hostExecutionPhase: _hostExecutionPhase,
    stopping: _stopping,
    restartResume: _restartResume,
    ...retained
  } = summary
  return retained
}

/** What a restart knows of a chat it has not opened (`atRestStructuredStatusSummary`). */
export type StructuredAgentSessionAtRest = {
  interrupted: boolean
  lastSequence: number
  lastSavedAt: number
}

/**
 * A restored chat's row before anything opens it, from its record and its journal's rest facts:
 * Interrupted when a turn was open as its host stopped, else Done, and no row while it holds no
 * history. After a restart those are the only states a chat can be in; previews and a failed
 * turn's mark come with the journal's own row, on first open.
 */
export function atRestStructuredStatusSummary(
  record: AgentSessionRecord,
  rest: StructuredAgentSessionAtRest,
  deps: Pick<StructuredAgentSessionStatusFeedDeps, 'namingFailure' | 'now'>
): AgentSessionStatusSummary {
  // Sequence 1 is the epoch row: a chat with nothing after it has never been sent anything.
  const status = rest.interrupted || rest.lastSequence > 1 ? ('idle' as const) : null
  return {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    status,
    latestPrompt: '',
    ...(status && rest.interrupted ? { turnOutcome: 'interruption' as const } : {}),
    ...structuredSummaryRecordFields(record, deps.namingFailure?.(record.sessionId)),
    updatedAt: rest.lastSavedAt || deps.now()
  }
}

/** What a row reads off the record, opened or not. */
function structuredSummaryRecordFields(
  record: AgentSessionRecord | null,
  namingFailure: StructuredChatNamingFailure | undefined
): Pick<
  AgentSessionStatusSummary,
  | 'rewindBlockedReason'
  | 'model'
  | 'permissionMode'
  | 'providerSession'
  | 'launchDirectory'
  | 'conversationName'
  | 'namingError'
  | 'sleptAt'
> {
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  const permissionMode = record?.permissionMode
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  return {
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(isAgentChatPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...structuredSummaryConversationNaming(record, namingFailure),
    ...(typeof record?.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {})
  }
}

/** The record's name, and the failure to replace it only while that is still the name. */
function structuredSummaryConversationNaming(
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

/** A closed chat's retained summary with current record annotations, or null if unchanged. */
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
