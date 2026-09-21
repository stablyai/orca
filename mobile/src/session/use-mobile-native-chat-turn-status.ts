import { useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  nativeChatTurnHasResponse,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../src/shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

export const MOBILE_UNANCHORED_TURN_KEY = '__unanchored__'
const EMPTY_TURN_TIMING_BY_TURN: NativeChatTurnTimingByTurn = Object.freeze({})

type ScopedTurnTiming = {
  scopeKey: string
  timingByTurn: NativeChatTurnTimingByTurn
}

/** Per-turn "Thinking / Working for N / Worked for N" timing, on the same shared
 *  state machine the desktop renderer uses so the two surfaces stamp turns alike. */
export function useMobileNativeChatTurnStatus({
  messages,
  enabled,
  isWorking,
  workingStartedAt,
  scopeKey
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking: boolean
  workingStartedAt?: number | null
  /** Host/worktree/tab identity. Timings never carry across chat surfaces. */
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  activeTurnKey: string
} {
  const latestUserIndex = enabled
    ? messages.findLastIndex((message) => message.role === 'user')
    : -1
  const hasCurrentTurnResponse = enabled && nativeChatTurnHasResponse(messages, latestUserIndex)
  const latestUserId = latestUserIndex !== -1 ? (messages[latestUserIndex]?.id ?? null) : null
  const activeTurnKey = latestUserId ?? MOBILE_UNANCHORED_TURN_KEY
  const [scopedTiming, setScopedTiming] = useState<ScopedTurnTiming>(() => ({
    scopeKey,
    timingByTurn: {}
  }))
  // Do not expose the previous surface's state during the render before the
  // timing effect adopts the new scope, or scan it while this UI is disabled.
  const timingByTurn =
    enabled && scopedTiming.scopeKey === scopeKey
      ? scopedTiming.timingByTurn
      : EMPTY_TURN_TIMING_BY_TURN
  // An accepted send renders as `pending-N` until the transcript echo lands under
  // its real id. That is one turn under two keys, so the clock must survive the swap.
  const previousActiveTurn = useRef<{ scopeKey: string; turnKey: string } | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const validTurnKeys = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.id)
    )
    const previousActiveTurnKey =
      previousActiveTurn.current?.scopeKey === scopeKey
        ? previousActiveTurn.current.turnKey
        : undefined
    previousActiveTurn.current = { scopeKey, turnKey: activeTurnKey }
    setScopedTiming((current) => {
      const currentTiming =
        current.scopeKey === scopeKey ? current.timingByTurn : EMPTY_TURN_TIMING_BY_TURN
      const nextTiming = reduceNativeChatTurnTiming(currentTiming, {
        activeTurnKey,
        previousActiveTurnKey,
        validTurnKeys,
        isWorking,
        workingStartedAt,
        now: Date.now()
      })
      return current.scopeKey === scopeKey && nextTiming === currentTiming
        ? current
        : { scopeKey, timingByTurn: nextTiming }
    })
  }, [activeTurnKey, enabled, isWorking, messages, scopeKey, workingStartedAt])

  // Why: the selection rebuilds its status objects on every call, and a streaming
  // turn re-renders ~20x/s. Without this, every settled turn's row gets fresh
  // props each tick and the memoized message rows all re-render.
  const turnIsWorking = enabled && isWorking
  const statuses = useMemo(
    () =>
      selectNativeChatTurnStatuses(timingByTurn, {
        activeTurnKey,
        isWorking: turnIsWorking,
        workingStartedAt,
        hasCurrentTurnResponse
      }),
    [timingByTurn, activeTurnKey, turnIsWorking, workingStartedAt, hasCurrentTurnResponse]
  )
  return { ...statuses, activeTurnKey }
}
