import { useCallback, useMemo, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal,
  type NativeChatTurnMembership
} from '../../../src/shared/native-chat-turn-membership'
import {
  MOBILE_UNANCHORED_TURN_KEY,
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const NO_MEMBERSHIP: NativeChatTurnMembership = { turnKeys: [], liveTurnKey: undefined }
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
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  thinking = false,
  activityText = null,
  scopeKey
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking: boolean
  workingStartedAt?: number | null
  /** Host-recorded durations; they outrank whatever this client observed. */
  settledTurns?: NativeChatSettledTurns | null
  /** The journal that places each row in its turn; absent groups rows by position. */
  turnJournal?: NativeChatTurnJournal | null
  /** Whether the turn is reasoning right now, derived from its journal content. */
  thinking?: boolean
  /** What the provider says the live turn is doing; outranks the other labels. */
  activityText?: string | null
  /** Host/worktree/tab identity for timing and disclosure isolation. */
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  /** The live turn's provider activity copy, for the footer row. */
  activeActivityText: string | null
  onToggleTurn: (turnKey: string) => void
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
} {
  // Resolve each row's turn, and which turn is live, once from the turn record when the host
  // states scopes.
  const { turnKeys, liveTurnKey } = useMemo(
    () => (enabled ? nativeChatTurnMembership(messages, turnJournal) : NO_MEMBERSHIP),
    [enabled, messages, turnJournal]
  )
  const turnStatuses = useMobileNativeChatTurnStatus({
    turnKeys,
    liveTurnKey,
    enabled,
    isWorking,
    workingStartedAt,
    settledTurns,
    thinking,
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
  // A settled turn's status draws at its first row.
  const firstRowOfTurn = useMemo(() => {
    const first = new Map<string, number>()
    for (const [index, turnKey] of turnKeys.entries()) {
      if (turnKey !== undefined && !first.has(turnKey)) {
        first.set(turnKey, index)
      }
    }
    return first
  }, [turnKeys])

  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const activeActivityText = enabled && isWorking ? (activityText ?? null) : null
  const resolveRow = useCallback(
    (index: number, _message: NativeChatMessage): MobileNativeChatTurnRow => {
      const turnKey = turnKeys[index]
      const turnStatus =
        enabled && turnKey !== undefined && firstRowOfTurn.get(turnKey) === index
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
          (liveTurnKey !== undefined
            ? turnKey === liveTurnKey
            : turnKey === undefined && activeTurnKey === MOBILE_UNANCHORED_TURN_KEY)
      }
    },
    [
      turnKeys,
      firstRowOfTurn,
      liveTurnKey,
      enabled,
      activeTurnKey,
      completedByTurn,
      expandedTurnIds,
      isWorking
    ]
  )

  return {
    active,
    activeActivityText,
    /** Stable for a given chat scope, so it never disturbs a row's memo. */
    onToggleTurn: toggleExpandedTurn,
    resolveRow
  }
}
