import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatSettledTurn } from '../../../src/shared/native-chat-turn-status'
import {
  selectStructuredAgentRunningTurnTiming,
  selectStructuredAgentSettledTurns,
  structuredAgentTurnLocalStartedAt
} from '../../../src/shared/structured-agent-session-turn-timing'

type TurnAnchor = { turnId: string; startedAt: number | null }

/** The host's clock as last published, paired with the client clock at receipt. */
type HostClock = { hostNow: number; receivedAt: number }

/** The live turn's local-clock anchor. Null when its row carries no host start
 *  (older hosts), so local observation applies. */
function anchorRunningTurn(
  items: readonly AgentJournalRenderItem[],
  turnId: string,
  hostClock: HostClock | null | undefined
): TurnAnchor {
  const timing = selectStructuredAgentRunningTurnTiming(items, turnId)
  if (!timing) {
    return { turnId, startedAt: null }
  }
  const now = Date.now()
  // Advance the published host clock by the client time since receipt; both
  // terms stay single-clock, so a mid-turn attach counts from the real start.
  const hostNow = hostClock ? hostClock.hostNow + (now - hostClock.receivedAt) : undefined
  return { turnId, startedAt: structuredAgentTurnLocalStartedAt(timing, now, hostNow) }
}

/** Host-recorded turn timing for the structured lane: settled durations straight
 *  off the journal, and a skew-free start for the live counter stamped once per
 *  turn so re-renders never move it. */
export function useMobileStructuredAgentTurnTiming(
  {
    items,
    submissions,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    hostClock?: HostClock | null
  },
  turnId: string | null
): { settledTurns: ReadonlyMap<string, NativeChatSettledTurn>; workingStartedAt: number | null } {
  const settledTurns = useMemo(
    () => selectStructuredAgentSettledTurns(items, submissions),
    [items, submissions]
  )
  const [anchor, setAnchor] = useState<TurnAnchor | null>(null)
  // Stamp during render (React's derive-from-props pattern) so the first paint of
  // a new turn already counts from the right instant.
  if (turnId === null) {
    if (anchor !== null) {
      setAnchor(null)
    }
    return { settledTurns, workingStartedAt: null }
  }
  if (anchor?.turnId !== turnId) {
    const next = anchorRunningTurn(items, turnId, hostClock)
    setAnchor(next)
    return { settledTurns, workingStartedAt: next.startedAt }
  }
  return { settledTurns, workingStartedAt: anchor.startedAt }
}
