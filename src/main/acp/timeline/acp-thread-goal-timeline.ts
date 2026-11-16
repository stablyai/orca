// An agent-owned goal becomes one revised status row per goal; each clear is a newer row so it outranks the goal.

import {
  AGENT_SESSION_THREAD_GOAL_ACCOUNTING_REVISION_SECONDS,
  AGENT_SESSION_THREAD_GOAL_PRESENTATION
} from '../../../shared/agent-session/agent-session-thread-goal'
import type { AgentJournalThreadGoal } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpThreadGoalReport } from '../acp-dialects/acp-dialect'

type Shown = { id: string; goal: AgentJournalThreadGoal } | 'cleared'

export class AcpThreadGoalTimeline {
  /** Null until this child reports a goal transition. */
  private shown: Shown | null = null

  update(
    report: AcpThreadGoalReport | undefined,
    join: ProviderTimelineJoin,
    at: number
  ): ProviderTimelineEvent[] {
    if (!report) {
      return []
    }
    const shown = this.shown
    if (report.goal === null) {
      if (shown === 'cleared') {
        return []
      }
      this.shown = 'cleared'
      return [
        {
          type: 'item.update',
          item: `goal-cleared:${at}`,
          body: {
            kind: 'status',
            text: 'Goal cleared',
            presentation: AGENT_SESSION_THREAD_GOAL_PRESENTATION,
            threadGoal: { state: 'cleared' }
          },
          join
        }
      ]
    }
    const { id, ...reported } = report.goal
    const same = shown !== 'cleared' && shown?.id === id ? shown.goal : null
    if (
      same &&
      same.status === reported.status &&
      same.objective === reported.objective &&
      same.tokenBudget === reported.tokenBudget &&
      reported.timeUsedSeconds - same.timeUsedSeconds <
        AGENT_SESSION_THREAD_GOAL_ACCOUNTING_REVISION_SECONDS
    ) {
      return []
    }
    const goal: AgentJournalThreadGoal = {
      ...reported,
      createdAt: same?.createdAt ?? at,
      updatedAt: at
    }
    this.shown = { id, goal }
    return [
      {
        type: 'item.update',
        item: `goal:${id}`,
        body: {
          kind: 'status',
          text: `Goal: ${goal.objective}`,
          presentation: AGENT_SESSION_THREAD_GOAL_PRESENTATION,
          threadGoal: { state: 'set', goal }
        },
        join
      }
    ]
  }
}
