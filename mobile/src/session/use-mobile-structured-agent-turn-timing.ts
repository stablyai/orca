import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../src/shared/agent-session-wire'
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
    items,
    submissions,
    latestTurn,
    working,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    working?: boolean
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null
): {
  settledTurns: NativeChatSettledTurns
  turnJournal: NativeChatTurnJournal
  workingStartedAt: number | null
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
  return { settledTurns, turnJournal, workingStartedAt: step.workingStartedAt }
}
