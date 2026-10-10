// What the status summary carries of a session's child records, and when a change to them is
// worth re-broadcasting to every session list.
//
// The summary reaches every subscriber, remote ones included, so it carries each child's facts but
// not its per-tick freshness: usage never, and an evidence clock only once it has moved far enough
// to change the minute a "no update" reading shows. The background-task channel, which only an
// open chat subscribes to, carries every tick.

import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentChildWorkViewsEqual } from '../../../shared/agent-status-child-work-view-wire'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'
import {
  agentChildWorkSummaryViews,
  AGENT_CHILD_SUMMARY_CLOCK_GRAIN_MS
} from '../../../shared/agent-child-work-listing'

/** An evidence clock that advanced by less than this does not re-broadcast a summary.
 *  Invariant: every reader of the summary's child clocks shows staleness no finer than this (today,
 *  whole minutes); a reader that needs finer freshness reads the background-task channel, which
 *  carries every tick. The comparison is index-wise, so it relies on the store's read keeping
 *  insertion order: a read that sorted would turn every reorder into a broadcast. */
export const SUMMARY_CHILD_CLOCK_TOLERANCE_MS = AGENT_CHILD_SUMMARY_CLOCK_GRAIN_MS

export type StructuredStatusChildWork = {
  children?: AgentChildWorkView[]
  backgroundTasks?: AgentSessionBackgroundTask[]
}

/** The summary's child fields: the running views without usage, since the sidebar lists running
 *  children only, and the live legacy tasks an older client reads, derived from the same views so
 *  the two cannot disagree. */
export function structuredStatusChildWork(
  views: readonly AgentChildWorkView[] | undefined,
  provider: StructuredAgentId
): StructuredStatusChildWork {
  const children = agentChildWorkSummaryViews(views ?? [])
  if (children.length === 0) {
    return {}
  }
  // `tasks` only, the live rows: an old client folds every listed task into the parent, and
  // reads a failed one's legacy `blocked` as still running. Dies with the legacy shapes; see the
  // death condition in `structured-agent-session-child-work-legacy`.
  const { tasks } = structuredChildWorkLegacyTasks(children, provider)
  return { children, ...(tasks ? { backgroundTasks: tasks } : {}) }
}

export function structuredStatusChildrenEqual(
  a: readonly AgentChildWorkView[] | undefined,
  b: readonly AgentChildWorkView[] | undefined
): boolean {
  return agentChildWorkViewsEqual(a, b, SUMMARY_CHILD_CLOCK_TOLERANCE_MS)
}

/** The user's newest send the provider accepted (a message, a steer or a command), keyed by the
 *  journal epoch: its change is the user's next turn. A turn the provider opens itself, such as
 *  Claude waking the agent when a background task ends, carries no send, and a subagent's turn is
 *  never one; a rewind replaces the epoch. */
export function newestAcceptedSendKey(
  epoch: string,
  submissions: readonly AgentJournalSubmission[]
): string {
  const accepted = submissions.findLast((submission) => submission.dispatchState === 'accepted')
  return `${epoch}:${accepted?.clientMessageId ?? ''}`
}
