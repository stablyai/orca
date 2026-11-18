// A chat that keeps dying while it is continued must not be continued forever. The journal is the
// count: each continuation the agent took leaves Orca's note, and each send carries its offer's tag.

import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import { isRestartContinuationOf } from './structured-agent-session-restart-continuation-envelope'

export const RESTART_AUTO_CONTINUATION_LIMIT = 3
export const RESTART_AUTO_CONTINUATION_WINDOW_MS = 5 * 60_000

/** Orca's note that the agent took a continuation; a refused or unconfirmed one carries a tone. */
function isTakenContinuationNote(item: AgentJournalRenderItem): boolean {
  const identity = parseAgentJournalItemKey(item.itemId)
  return (
    item.body.kind === 'status' &&
    item.body.tone === undefined &&
    identity?.provider === 'orca' &&
    identity.clientMessageId.startsWith(RESTART_CONTINUATION_ROW_PREFIX)
  )
}

/** Whether Orca may continue this offer on its own; a person may still choose to. */
export function restartAutoContinuationAllowed(
  marker: AgentSessionResumeMarker,
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  now: number
): boolean {
  // Each cut is continued at most once: an earlier send for this very offer ends it.
  if (
    journal.submissions.some((submission) =>
      isRestartContinuationOf(marker, submission.clientMessageId)
    )
  ) {
    return false
  }
  const recent = journal.items.filter(
    (item) =>
      isTakenContinuationNote(item) && now - item.observedAt <= RESTART_AUTO_CONTINUATION_WINDOW_MS
  ).length
  return recent < RESTART_AUTO_CONTINUATION_LIMIT
}
