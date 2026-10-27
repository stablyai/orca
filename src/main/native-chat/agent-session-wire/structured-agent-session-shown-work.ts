// Reuse the sidebar’s lead/child fold for teardown so restart offers match visible work.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  structuredAgentSessionAgentStatus,
  type StructuredAgentSessionAgentStatus
} from '../../../shared/structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionWorkScope } from '../../../shared/structured-agent-session-main-agent-working'

export function structuredAgentSessionShownStatus(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  childWork: readonly AgentChildWorkView[] | undefined,
  fence: number | undefined,
  scope?: StructuredAgentSessionWorkScope
): StructuredAgentSessionAgentStatus {
  const status = projectStructuredAgentSessionStatus(
    journal.items,
    journal.submissions,
    fence,
    scope
  )
  return structuredAgentSessionAgentStatus({
    status,
    ...(childWork ? { childWork } : {})
  })
}
