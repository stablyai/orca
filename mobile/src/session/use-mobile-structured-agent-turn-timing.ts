import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../src/shared/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-options-result'
import {
  agentSessionThreadGoalFromReport,
  isAgentSessionThreadGoalOpen
} from '../../../src/shared/agent-session-thread-goal'
import type { MobileNativeChatThreadGoal } from './use-mobile-native-chat-session'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { StructuredAgentHostClock } from '../../../src/shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../src/shared/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../src/shared/structured-agent-turn-clock-anchor'

// Use journal durations and latch the host-to-phone start conversion once per turn so counters remain skew-free.
export function useMobileStructuredAgentTurnTiming(
  {
    items: journalItems,
    submissions,
    latestTurn,
    working,
    hostClock,
    threadGoalReport,
    connected = true,
    epoch
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    working?: boolean
    hostClock?: StructuredAgentHostClock | null
    threadGoalReport?:
      | AgentSessionOptionsResult['threadGoal']
      | AgentSessionOptionsResult['reportedThreadGoal']
    connected?: boolean
    epoch?: string | null
  },
  turnId: string | null,
  items: readonly AgentJournalRenderItem[] = journalItems
): {
  settledTurns: NativeChatSettledTurns
  turnJournal: NativeChatTurnJournal
  workingStartedAt: number | null
  threadGoal: MobileNativeChatThreadGoal | null
} {
  const { settledTurns, runningTiming } = useMemo(
    () => selectStructuredAgentTurnBars(items, submissions, turnId, latestTurn),
    [items, submissions, turnId, latestTurn]
  )
  const turnJournal = useMemo(
    () => ({ items, submissions, latestTurn, ...(working !== undefined ? { working } : {}) }),
    [items, submissions, latestTurn, working]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  // Derive during render so a new turn’s first paint counts from its correct start.
  const step = stepStructuredAgentTurnClock({
    timing: runningTiming,
    turnId,
    now: Date.now,
    hostClock,
    latch
  })
  if (step.latch !== latch) {
    setLatch(step.latch)
  }
  const goal =
    threadGoalReport === undefined
      ? null
      : agentSessionThreadGoalFromReport(journalItems, threadGoalReport, epoch)
  const threadGoal =
    goal !== null && isAgentSessionThreadGoalOpen(goal)
      ? {
          goal,
          runningTurn:
            connected && hostClock && working !== false && turnId !== null
              ? { startedAt: runningTiming?.startedAt ?? null }
              : null,
          hostClockOffsetMs: hostClock ? hostClock.receivedAt - hostClock.hostNow : 0
        }
      : null
  return { settledTurns, turnJournal, workingStartedAt: step.workingStartedAt, threadGoal }
}
