import { finishAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
// Broadcast only child facts and minute-scale freshness; per-tick usage/clocks stay on the chat’s background channel.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session/agent-session-background-task-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status/child-work/agent-status-child-work-view'
import { agentChildWorkViewsEqual } from '../../../shared/agent-status/child-work/agent-status-child-work-view-wire'
import { structuredChildWorkLegacyTasks } from '../../../shared/agent-session/structured-agent-session-child-work-legacy'
import { structuredRunningChildWork } from '../../../shared/agent-status/child-work/agent-child-work-listing'

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
  return finishAgentSessionSteps(newestAcceptedSendKeySteps(epoch, submissions))
}

export function* newestAcceptedSendKeySteps(
  epoch: string,
  submissions: readonly AgentJournalSubmission[]
): Generator<void, string> {
  for (let index = submissions.length - 1; index >= 0; index--) {
    yield
    if (submissions[index].dispatchState === 'accepted') {
      return `${epoch}:${submissions[index].clientMessageId}`
    }
  }
  return `${epoch}:`
}

/** Display effects follow prior row adoption while execution obligations remain immediate. */
export function publishOrderedStructuredChildWork(
  journal: Pick<AgentSessionJournal, 'readInOrder'>,
  publish: () => void,
  failed: (error: unknown) => void
): void {
  void journal.readInOrder(publish).catch(failed)
}
