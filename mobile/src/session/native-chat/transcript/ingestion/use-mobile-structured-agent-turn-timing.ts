import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../../../../src/shared/agent-session/agent-session-wire'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { StructuredAgentHostClock } from '../../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { createStructuredAgentTurnBarsSelector } from '../../../../../../src/shared/agent-session/view/structured-agent-session-turn-timing'
import { structuredAgentSessionSendingItemIds } from '../../../../../../src/shared/agent-session/view/structured-agent-session-sending'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../../../../src/shared/native-chat/transcript/turns/structured-agent-turn-clock-anchor'

export type MobileNativeChatTurnJournal = NativeChatTurnJournal & {
  sendingItemIds?: ReadonlySet<string>
}

// Use journal durations and latch the host-to-phone start conversion once per turn so counters remain skew-free.
export function useMobileStructuredAgentTurnTiming(
  {
    submissions,
    latestTurn,
    working,
    hostClock
  }: {
    submissions: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    working?: boolean
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null,
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  items: readonly AgentJournalRenderItem[]
): {
  settledTurns: NativeChatSettledTurns
  turnJournal: MobileNativeChatTurnJournal
  workingStartedAt: number | null
} {
  const selectTurnBars = useMemo(() => createStructuredAgentTurnBarsSelector(), [])
  const { settledTurns, runningTiming } = selectTurnBars(items, submissions, turnId, latestTurn)
  const sendingItemIds = useMemo(
    () => structuredAgentSessionSendingItemIds(optimistic, submissions),
    [optimistic, submissions]
  )
  const turnJournal = useMemo(
    () => ({
      items,
      submissions,
      latestTurn,
      sendingItemIds,
      ...(working !== undefined ? { working } : {})
    }),
    [items, submissions, latestTurn, sendingItemIds, working]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  const step = stepStructuredAgentTurnClock({
    timing: runningTiming,
    turnId: runningTiming ? turnId : null,
    now: Date.now,
    hostClock,
    latch
  })
  if (step.latch !== latch) {
    setLatch(step.latch)
  }
  return { settledTurns, turnJournal, workingStartedAt: step.workingStartedAt }
}
