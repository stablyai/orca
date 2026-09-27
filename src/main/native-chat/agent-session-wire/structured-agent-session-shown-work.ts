// Whether a structured session is doing work, asked the one way the product answers it.
//
// The status feed publishes the lead's journal status beside the provider's live background roster,
// and the store ingest folds the two into the row the sidebar shows. The quit snapshot composes the
// same two inputs through the same fold, so it cannot offer a different set of chats than the one
// the user saw working.

import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-background-task-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionAgentStatus,
  type StructuredAgentSessionAgentStatus
} from '../../../shared/structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'

/** The full row the sidebar's fold would show, for callers that need the lead's own state beside
 *  the working answer — the teardown snapshot records both from this one computation. */
export function structuredAgentSessionShownStatus(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  backgroundTasks: readonly AgentSessionBackgroundTask[] | null | undefined,
  /** The session's lease fence, as the status feed passes it: a send from an older one is not work. */
  fence: number | undefined
): StructuredAgentSessionAgentStatus {
  const status = projectStructuredAgentSessionStatus(journal.items, journal.submissions, fence)
  return structuredAgentSessionAgentStatus({
    status,
    ...(backgroundTasks ? { backgroundTasks: [...backgroundTasks] } : {})
  })
}
