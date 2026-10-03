// One structured session's status row, built the same way whether its projected fields come from
// an open journal or from the status stored beside it (journal-session-state.ts), so a row seeded
// at startup and the row the chat's open later publishes are equal field for field.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import type { StructuredStatusChildWork } from './structured-agent-session-status-child-work'

export function structuredAgentSessionStatusSummary(input: {
  sessionId: string
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  record: AgentSessionRecord | null
  child?: Pick<StructuredAgentSessionProviderChild, 'phase'> | null
  projected: StructuredAgentSessionStatusProjection
  childWork: StructuredStatusChildWork
  /** The journal's newest activity; 0 when it can date none. */
  lastActivityAt: number
  now: () => number
}): AgentSessionStatusSummary {
  const { record, child } = input
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  return {
    sessionId: input.sessionId,
    workspaceId: input.params.location.workspaceId,
    agent: input.params.provider,
    ...(child
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: child.phase
        }
      : {}),
    ...input.projected,
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...statusSummaryChildWorkFields(input.childWork),
    ...(providerSession ? { providerSession } : {}),
    updatedAt: input.lastActivityAt || input.now()
  }
}

/** The summary's child fields. Usage is dropped on purpose: a `task_progress` tick would otherwise
 *  fail the equality check and re-broadcast a full summary to every remote subscriber for a number
 *  no session list renders. Tokens stay live on the background-task channel. */
export function statusSummaryChildWorkFields({
  children,
  backgroundTasks
}: StructuredStatusChildWork): Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'> {
  return {
    ...(backgroundTasks && backgroundTasks.length > 0
      ? { backgroundTasks: backgroundTasks.map(({ totalTokens: _tokens, ...task }) => task) }
      : {}),
    ...(children ? { children } : {})
  }
}
