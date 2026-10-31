// Broadcast only child facts and minute-scale freshness; per-tick usage/clocks stay on the chat’s background channel.

import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentChildWorkViewsEqual } from '../../../shared/agent-status-child-work-view-wire'
import { structuredChildWorkLegacyTasks } from '../../../shared/agent-session/structured-agent-session-child-work-legacy'
import { structuredRunningChildWork } from '../../../shared/agent-child-work-listing'

/** Summary readers show minute-level staleness; index-wise comparison requires stable insertion order. */
export const SUMMARY_CHILD_CLOCK_TOLERANCE_MS = 60_000

export type StructuredStatusChildWork = {
  children?: AgentChildWorkView[]
  backgroundTasks?: AgentSessionBackgroundTask[]
}

/** Derive running views and legacy tasks together, excluding usage from global summaries. */
export function structuredStatusChildWork(
  views: readonly AgentChildWorkView[] | undefined,
  provider: StructuredAgentId
): StructuredStatusChildWork {
  const running = views ? structuredRunningChildWork(views) : []
  if (running.length === 0) {
    return {}
  }
  const children = running.map(({ totalTokens: _totalTokens, ...view }) => view)
  // Old clients treat failed blocked tasks as live, so legacy lists must contain running records only.
  const { tasks } = structuredChildWorkLegacyTasks(children, provider)
  return { children, ...(tasks ? { backgroundTasks: tasks } : {}) }
}

/** Exclude per-tick usage from global broadcasts; chat background channels retain it. */
export function structuredStatusChildWorkFields(
  views: readonly AgentChildWorkView[] | undefined,
  provider: StructuredAgentId
): StructuredStatusChildWork {
  const { children, backgroundTasks } = structuredStatusChildWork(views, provider)
  return {
    ...(backgroundTasks && backgroundTasks.length > 0
      ? { backgroundTasks: backgroundTasks.map(({ totalTokens: _tokens, ...task }) => task) }
      : {}),
    ...(children ? { children } : {})
  }
}

export function structuredStatusChildrenEqual(
  a: readonly AgentChildWorkView[] | undefined,
  b: readonly AgentChildWorkView[] | undefined
): boolean {
  return agentChildWorkViewsEqual(a, b, SUMMARY_CHILD_CLOCK_TOLERANCE_MS)
}

/** Accepted-send/epoch identity marks user turns; provider wake-ups and subagent turns carry no user send. */
export function newestAcceptedSendKey(
  epoch: string,
  submissions: readonly AgentJournalSubmission[]
): string {
  const accepted = submissions.findLast((submission) => submission.dispatchState === 'accepted')
  return `${epoch}:${accepted?.clientMessageId ?? ''}`
}
