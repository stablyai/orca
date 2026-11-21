import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../../../../src/shared/agent-session/agent-session-wire'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { StructuredAgentHostClock } from '../../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../../../../src/shared/agent-session/view/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../../../../src/shared/native-chat/transcript/turns/structured-agent-turn-clock-anchor'
import { rowsBesideStreamedText } from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'

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
  // Turn timing never reads reply text, so a streaming reply keeps the memo.
  const rows = rowsBesideStreamedText(items)
  const { settledTurns, runningTiming } = useMemo(
    () => selectStructuredAgentTurnBars(rows, submissions, turnId, latestTurn),
    [rows, submissions, turnId, latestTurn]
  )
  // Turn membership, fork points and the first screen read rows and turns, never reply text, so
  // they keep their memos while a reply streams too.
  const turnJournal = useMemo(
    () => ({ items: rows, submissions, latestTurn, ...(working !== undefined ? { working } : {}) }),
    [rows, submissions, latestTurn, working]
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
