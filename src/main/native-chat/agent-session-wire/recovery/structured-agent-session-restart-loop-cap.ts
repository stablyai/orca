// A chat that keeps dying while it is continued must not be continued forever. The journal is the
// count: each continuation the agent took leaves Orca's note, and each send carries its offer's tag,
// so a crash offer's sends count even when the run died before writing the note.

import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import {
  isRestartContinuationOf,
  readRestartContinuationId,
  restartOfferTag
} from './structured-agent-session-restart-continuation-envelope'
import { crashCutTeardownId } from './structured-agent-session-crash-cut-marker'

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
  now: number,
  /** Runs that recently crashed; sends for their offers count without a note. */
  recentCrashes: readonly string[] = []
): boolean {
  // Each cut is continued at most once: an earlier send for this very offer ends it.
  if (
    journal.submissions.some((submission) =>
      isRestartContinuationOf(marker, submission.clientMessageId)
    )
  ) {
    return false
  }
  const recent = (at: number) => now - at <= RESTART_AUTO_CONTINUATION_WINDOW_MS
  const taken = journal.items.filter(
    (item) => isTakenContinuationNote(item) && recent(item.observedAt)
  ).length
  const crashTags = new Set(
    recentCrashes.map((runtime) =>
      restartOfferTag({ teardownId: crashCutTeardownId(runtime), sessionId: marker.sessionId })
    )
  )
  const sentForCrashes = journal.submissions.filter((submission) => {
    const sent = readRestartContinuationId(submission.clientMessageId)
    return sent !== null && crashTags.has(sent.offerTag) && recent(sent.sentAt)
  }).length
  // Most continuations show in both counts; the larger one is the floor.
  return Math.max(taken, sentForCrashes) < RESTART_AUTO_CONTINUATION_LIMIT
}
