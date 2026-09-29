import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import type { StructuredAgentHostClock } from '../../../src/shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../src/shared/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../src/shared/structured-agent-turn-clock-anchor'

/** Host-recorded turn timing for the structured lane: settled durations straight
 *  off the journal, the transcript key that owns the running turn's bar, each
 *  row's owning turn, and a
 *  skew-free start for the live counter whose host-to-local conversion is latched
 *  once per turn. */
export function useMobileStructuredAgentTurnTiming(
  {
    items,
    submissions,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null
): {
  settledTurns: NativeChatSettledTurns
  workingStartedAt: number | null
  activeTurnOpenedBy: string | null
  turnKeysByItemId: ReadonlyMap<string, string>
} {
  const { settledTurns, runningTiming, activeTurnOpenedBy, turnKeysByItemId } = useMemo(
    () => selectStructuredAgentTurnBars(items, submissions, turnId),
    [items, submissions, turnId]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  // Stamp during render (React's derive-from-props pattern) so the first paint of
  // a new turn already counts from the right instant.
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
  return {
    settledTurns,
    workingStartedAt: step.workingStartedAt,
    activeTurnOpenedBy,
    turnKeysByItemId
  }
}
