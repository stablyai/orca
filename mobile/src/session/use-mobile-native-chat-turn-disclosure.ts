import { useCallback, useMemo, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  MOBILE_UNANCHORED_TURN_KEY,
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const EMPTY_TURN_KEYS: readonly undefined[] = []
const MAX_EXPANDED_TURNS = 128

export type MobileNativeChatTurnRow = {
  turnStatus: NativeChatTurnStatus | null
  turnExpanded: boolean
  /** Set only on a settled turn — the one row that has activity to disclose. */
  turnKey?: string
  activeTurnIsWorking: boolean
}

/** Owns the transcript's per-turn status rows and their disclosure state, and
 *  resolves what one list row needs. Bridge-lane chats pass `enabled: false` and
 *  keep their single three-dot working indicator instead. */
export function useMobileNativeChatTurnDisclosure({
  messages,
  enabled,
  isWorking,
  scopeKey
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking: boolean
  /** Host/worktree/tab identity for timing and disclosure isolation. */
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  /** True when the live turn has no user message to hang its status row under. */
  activeTurnIsUnanchored: boolean
  onToggleTurn: (turnKey: string) => void
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
} {
  const turnStatuses = useMobileNativeChatTurnStatus({
    messages,
    enabled,
    isWorking,
    scopeKey
  })
  const [expandedTurns, setExpandedTurns] = useState<{
    scopeKey: string
    turnIds: ReadonlySet<string>
  }>(() => ({ scopeKey, turnIds: new Set() }))
  const expandedTurnIds =
    expandedTurns.scopeKey === scopeKey ? expandedTurns.turnIds : EMPTY_TURN_IDS
  const toggleExpandedTurn = useCallback(
    (turnKey: string) => {
      setExpandedTurns((current) => {
        const next = new Set(current.scopeKey === scopeKey ? current.turnIds : [])
        if (!next.delete(turnKey)) {
          if (next.size >= MAX_EXPANDED_TURNS) {
            const oldest = next.values().next().value
            if (oldest) {
              next.delete(oldest)
            }
          }
          next.add(turnKey)
        }
        return { scopeKey, turnIds: next }
      })
    },
    [scopeKey]
  )
  // Resolve each row's turn boundary once — a findLast per row is quadratic on a
  // long transcript.
  const turnKeys = useMemo(() => {
    if (!enabled) {
      return EMPTY_TURN_KEYS
    }
    let turnKey: string | undefined
    return messages.map((message) => {
      if (message.role === 'user') {
        turnKey = message.id
      }
      return turnKey
    })
  }, [enabled, messages])

  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const resolveRow = useCallback(
    (index: number, message: NativeChatMessage): MobileNativeChatTurnRow => {
      const turnKey = turnKeys[index]
      const turnStatus =
        !enabled || message.role !== 'user'
          ? null
          : turnKey === activeTurnKey
            ? active
            : turnKey
              ? (completedByTurn[turnKey] ?? null)
              : null
      return {
        turnStatus,
        turnExpanded: turnKey ? expandedTurnIds.has(turnKey) : false,
        // Why: the key travels and the row calls one stable handler with it. A
        // closure per row would be a new identity every render of a streaming
        // transcript, defeating the row's memo; caching one per turn would mean
        // writing a ref during render, which react-freeze can discard.
        turnKey: turnKey && turnStatus?.workedSeconds != null ? turnKey : undefined,
        // With no user boundary at all, the session's working state stays authoritative.
        activeTurnIsWorking:
          enabled &&
          isWorking &&
          (turnKey === activeTurnKey ||
            (turnKey === undefined && activeTurnKey === MOBILE_UNANCHORED_TURN_KEY))
      }
    },
    [turnKeys, enabled, activeTurnKey, active, completedByTurn, expandedTurnIds, isWorking]
  )

  return {
    active,
    /** Stable for a given chat scope, so it never disturbs a row's memo. */
    onToggleTurn: toggleExpandedTurn,
    activeTurnIsUnanchored:
      enabled && active != null && activeTurnKey === MOBILE_UNANCHORED_TURN_KEY,
    resolveRow
  }
}
