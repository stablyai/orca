import { useEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_UNANCHORED_TURN_KEY,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatSettledTurns,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../src/shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

const EMPTY_TURN_TIMING_BY_TURN: NativeChatTurnTimingByTurn = Object.freeze({})

type ScopedTurnTiming = {
  scopeKey: string
  timingByTurn: NativeChatTurnTimingByTurn
}

export function useMobileNativeChatTurnStatus({
  turnKeys,
  liveTurnKey,
  enabled,
  isWorking,
  workingStartedAt,
  settledTurns,
  thinking = false,
  scopeKey
}: {
  turnKeys: readonly (string | undefined)[]
  liveTurnKey: string | undefined
  enabled: boolean
  isWorking: boolean
  workingStartedAt?: number | null
  settledTurns?: NativeChatSettledTurns | null
  thinking?: boolean
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  activeTurnKey: string
} {
  const activeTurnKey = (enabled ? liveTurnKey : undefined) ?? NATIVE_CHAT_UNANCHORED_TURN_KEY
  const [scopedTiming, setScopedTiming] = useState<ScopedTurnTiming>(() => ({
    scopeKey,
    timingByTurn: {}
  }))
  // Hide old-scope timing before passive adoption so switched/disabled surfaces cannot expose it.
  const timingByTurn =
    enabled && scopedTiming.scopeKey === scopeKey
      ? scopedTiming.timingByTurn
      : EMPTY_TURN_TIMING_BY_TURN
  // Keep the clock when an initially unanchored live turn gains its row key.
  const previousActiveTurn = useRef<{ scopeKey: string; turnKey: string } | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const validTurnKeys = new Set(turnKeys.filter((turnKey) => turnKey !== undefined))
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
  }, [activeTurnKey, enabled, isWorking, scopeKey, turnKeys, workingStartedAt])

  // Reuse equivalent status objects so each streaming tick cannot invalidate every settled row’s memo.
  const turnIsWorking = enabled && isWorking
  const turnIsThinking = enabled && thinking
  const settledByTurn = enabled ? (settledTurns ?? undefined) : undefined
  const statuses = useMemo(
    () =>
      selectNativeChatTurnStatuses(timingByTurn, {
        activeTurnKey,
        isWorking: turnIsWorking,
        workingStartedAt,
        thinking: turnIsThinking,
        settledByTurn
      }),
    [timingByTurn, activeTurnKey, turnIsWorking, workingStartedAt, turnIsThinking, settledByTurn]
  )
  return { ...statuses, activeTurnKey }
}
