import { useCallback, useMemo, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { NATIVE_CHAT_UNANCHORED_TURN_KEY } from '../../../src/shared/native-chat-turn-status'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  nativeChatRowTurnKeys,
  nativeChatSelfAnchoredTurnRows
} from '../../../src/shared/native-chat-turn-grouping'
import {
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const EMPTY_TURN_KEYS: readonly undefined[] = []
const EMPTY_TURN_ANCHORS: ReadonlyMap<string, number> = new Map()
const MAX_EXPANDED_TURNS = 128

export type MobileNativeChatTurnRow = {
  turnStatus: NativeChatTurnStatus | null
  /** The bar renders above the row: its turn has no user bubble of its own. */
  turnStatusAbove?: boolean
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
  activeTurnOpenedBy = null,
  turnKeysByItemId = null,
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
  /** The key the host says anchors the running turn's bar; absent, the latest user message. */
  activeTurnOpenedBy?: string | null
  /** Host-attributed turn ownership per journal item id; unnamed rows keep
   *  positional preceding-user grouping. */
  turnKeysByItemId?: ReadonlyMap<string, string> | null
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
  const turnStatuses = useMobileNativeChatTurnStatus({
    messages,
    enabled,
    isWorking,
    workingStartedAt,
    settledTurns,
    activeTurnOpenedBy,
    turnKeysByItemId,
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
  // Resolve each row's owning turn once — a findLast per row is quadratic on a
  // long transcript.
  const turnKeys = useMemo(
    () => (enabled ? nativeChatRowTurnKeys(messages, turnKeysByItemId) : EMPTY_TURN_KEYS),
    [enabled, messages, turnKeysByItemId]
  )
  // A turn with no user bubble (provider-opened) anchors its bar at its first row.
  const selfAnchors = useMemo(
    () => (enabled ? nativeChatSelfAnchoredTurnRows(messages, turnKeys) : EMPTY_TURN_ANCHORS),
    [enabled, messages, turnKeys]
  )

  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const activeActivityText = enabled && isWorking ? (activityText ?? null) : null
  const resolveRow = useCallback(
    (index: number, message: NativeChatMessage): MobileNativeChatTurnRow => {
      const turnKey = turnKeys[index]
      const anchorsTurnHere = turnKey !== undefined && selfAnchors.get(turnKey) === index
      // The live turn's bar carries its running clock; it settles in place. Only
      // the bubble that opened a turn carries its bar: a message the provider
      // folded into a running turn shares the turn's key but not its bar.
      const turnStatus = !enabled
        ? null
        : message.role === 'user' && message.id === activeTurnKey
          ? active
          : message.role === 'user' && turnKey === message.id
            ? (completedByTurn[turnKey] ?? null)
            : anchorsTurnHere
              ? turnKey === activeTurnKey
                ? (active ?? completedByTurn[turnKey] ?? null)
                : (completedByTurn[turnKey] ?? null)
              : null
      return {
        turnStatus,
        ...(anchorsTurnHere && turnStatus !== null ? { turnStatusAbove: true } : {}),
        turnExpanded: turnKey ? expandedTurnIds.has(turnKey) : false,
        // Why: the key travels and the row calls one stable handler with it. A
        // closure per row would be a new identity every render of a streaming
        // transcript, defeating the row's memo; caching one per turn would mean
        // writing a ref during render, which react-freeze can discard.
        turnKey: turnKey && turnStatus?.workedSeconds != null ? turnKey : undefined,
        // Liveness is the owning turn's, not the newest prompt's: a running turn's
        // rows stay live while a newer message waits behind it.
        activeTurnIsWorking:
          enabled &&
          isWorking &&
          (turnKey === activeTurnKey ||
            (turnKey === undefined && activeTurnKey === NATIVE_CHAT_UNANCHORED_TURN_KEY))
      }
    },
    [
      turnKeys,
      selfAnchors,
      enabled,
      activeTurnKey,
      active,
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
