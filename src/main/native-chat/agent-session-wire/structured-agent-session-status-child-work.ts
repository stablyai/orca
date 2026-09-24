// What the status summary carries of a session's child records, and when a change to them is
// worth re-broadcasting to every session list.
//
// The summary reaches every subscriber, remote ones included, so it carries each child's facts but
// not its per-tick freshness: usage never, and an evidence clock only once it has moved far enough
// to change the minute a "no update" reading shows. The background-task channel, which only an
// open chat subscribes to, carries every tick.

import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentChildWorkViewsEqual } from '../../../shared/agent-status-child-work-view-wire'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'

/** An evidence clock that advanced by less than this does not re-broadcast a summary.
 *  Invariant: every reader of the summary's child clocks shows staleness no finer than this (today,
 *  whole minutes); a reader that needs finer freshness reads the background-task channel, which
 *  carries every tick. The comparison is index-wise, so it relies on the store's read keeping
 *  insertion order: a read that sorted would turn every reorder into a broadcast. */
export const SUMMARY_CHILD_CLOCK_TOLERANCE_MS = 60_000

export type StructuredStatusChildWork = {
  children?: AgentChildWorkView[]
  backgroundTasks?: AgentSessionBackgroundTask[]
}

/** The summary's child fields: the views without usage, and the live legacy tasks an older client
 *  reads, derived from the same views so the two cannot disagree. */
export function structuredStatusChildWork(
  views: readonly AgentChildWorkView[] | undefined,
  provider: AgentSessionHandleProvider
): StructuredStatusChildWork {
  if (!views || views.length === 0) {
    return {}
  }
  const children = views.map(({ totalTokens: _totalTokens, ...view }) => view)
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

/** The session's own newest turn, whatever state it is in; a subagent's rows never count. */
export function newestRootTurnId(items: readonly AgentJournalRenderItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const turn = isRootAgentJournalItem(item) ? readAgentJournalTurn(item?.body) : null
    if (turn) {
      return turn.turnId
    }
  }
  return null
}
