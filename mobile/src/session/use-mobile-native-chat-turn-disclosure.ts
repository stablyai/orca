import { useCallback, useMemo, useState } from 'react'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../src/shared/native-chat-row-content'
import {
  nativeChatTurnFold,
  type NativeChatTurnFoldRow
} from '../../../src/shared/native-chat-turn-fold'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  nativeChatMessagesWaitingBehindLiveTurn,
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../src/shared/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../src/shared/native-chat-turn-grouping'
import {
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const NO_TURN_KEYS: readonly undefined[] = []
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
  /** The list's rows, in the order they draw, less those waiting behind the live turn. */
  listMessages: readonly NativeChatMessage[]
  /** Rows waiting behind the live turn, drawn after its live status. */
  waitingRows: readonly { item: NativeChatMessage; index: number }[]
} {
  // Resolve each row's turn, which turn is live, and the order the rows draw in, once: from the
  // turn record when the host states scopes, else by journal order.
  const { rows, turnKeys, liveTurnKey } = useMemo(() => {
    if (!enabled) {
      return { rows: messages, turnKeys: NO_TURN_KEYS, liveTurnKey: undefined }
    }
    const membership = nativeChatTurnMembership(messages, turnJournal)
    return {
      rows: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
      turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
      liveTurnKey: membership.liveTurnKey
    }
  }, [enabled, messages, turnJournal])
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
  // A message waiting behind the live turn draws after that turn's live status, not in the list.
  const waiting = useMemo(() => {
    if (!enabled) {
      return {
        listMessages: rows,
        waitingRows: [],
        indexById: new Map<string, number>(),
        foldedRows: new Set<number>(),
        bars: new Map<string, { index: number; above: boolean }>()
      }
    }
    const ids = enabled ? nativeChatMessagesWaitingBehindLiveTurn(rows, turnJournal?.items) : null
    const foldRows: NativeChatTurnFoldRow[] = rows.map((message, index) => {
      const content = deriveNativeChatRowContent(message.blocks)
      return {
        turnKey: turnKeys[index],
        role: message.role,
        rendersProse: content.markdown.length > 0 || content.hasImages,
        outlivesTurn: message.blocks.some(
          (block) => isSubagentGroupBlock(block) || isBackgroundTaskBlock(block)
        ),
        reportsFailure: message.blocks.some(
          (block) => block.type === 'text' && block.tone === 'error'
        ),
        reportsCompaction: message.blocks.some(
          (block) => block.type === 'text' && block.presentation === 'compaction'
        )
      }
    })
    const settledTurnKeys = new Set(
      Object.entries(turnStatuses.completedByTurn)
        .filter(([, status]) => status.workedSeconds != null)
        .map(([turnKey]) => turnKey)
    )
    const { foldedRows: folded } = nativeChatTurnFold({
      rows: foldRows,
      settledTurnKeys,
      expandedTurnKeys: expandedTurnIds
    })
    const foldedRows = new Set(folded)
    const carrierRows = new Set<number>()
    // A provider-opened/history turn can have no user row in the loaded window. Keep a
    // first-row carrier for its settled status; settled tool content is hidden by the message
    // renderer, while the caret still has a row to attach to.
    const firstRowByTurn = new Map<string, number>()
    const hasAnswer = new Set<string>()
    for (const [index, row] of foldRows.entries()) {
      if (row.turnKey === undefined) {
        continue
      }
      if (!firstRowByTurn.has(row.turnKey)) {
        firstRowByTurn.set(row.turnKey, index)
      }
      if (
        row.rendersProse &&
        (row.role === 'assistant' || (row.role === 'system' && row.reportsFailure))
      ) {
        hasAnswer.add(row.turnKey)
      }
    }
    for (const [turnKey, index] of firstRowByTurn) {
      if (
        settledTurnKeys.has(turnKey) &&
        !hasAnswer.has(turnKey) &&
        !expandedTurnIds.has(turnKey) &&
        foldedRows.has(index)
      ) {
        foldedRows.delete(index)
        carrierRows.add(index)
      }
    }
    const indexById = new Map(rows.map((message, index) => [message.id, index]))
    const bars = new Map<string, { index: number; above: boolean }>()
    rows.forEach((message, index) => {
      const turnKey = turnKeys[index]
      if (turnKey !== undefined && !foldedRows.has(index) && !bars.has(turnKey)) {
        bars.set(turnKey, { index, above: message.id !== turnKey })
      }
    })
    const visibleMessage = (message: NativeChatMessage, index: number): NativeChatMessage =>
      carrierRows.has(index) ? { ...message, blocks: [] } : message
    const listMessages = rows.flatMap((message, index) =>
      foldedRows.has(index) ? [] : [visibleMessage(message, index)]
    )
    if (!ids?.size) {
      return { listMessages, waitingRows: [], indexById, foldedRows, bars }
    }
    return {
      listMessages: listMessages.filter((message) => !ids.has(message.id)),
      waitingRows: rows.flatMap((item, index) =>
        ids.has(item.id) && !foldedRows.has(index)
          ? [{ item: visibleMessage(item, index), index }]
          : []
      ),
      indexById,
      foldedRows,
      bars
    }
  }, [enabled, rows, turnJournal, turnKeys, turnStatuses.completedByTurn, expandedTurnIds])
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
  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const activeActivityText = enabled && isWorking ? (activityText ?? null) : null
  const resolveRow = useCallback(
    (listIndex: number, message: NativeChatMessage): MobileNativeChatTurnRow => {
      const index = waiting.indexById.get(message.id) ?? listIndex
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? undefined : waiting.bars.get(turnKey)
      // A turn's bar draws at its first row; the live turn's carries its running clock and settles
      // in place. A message folded into a turn (a steer) carries none.
      const turnStatus =
        enabled && turnKey !== undefined && bar?.index === index
          ? turnKey === activeTurnKey
            ? active
            : (completedByTurn[turnKey] ?? null)
          : null
      return {
        turnStatus,
        ...(bar?.above === true && turnStatus !== null ? { turnStatusAbove: true } : {}),
        turnExpanded: turnKey ? expandedTurnIds.has(turnKey) : false,
        // Why: the key travels and the row calls one stable handler with it. A
        // closure per row would be a new identity every render of a streaming
        // transcript, defeating the row's memo; caching one per turn would mean
        // writing a ref during render, which react-freeze can discard.
        turnKey: turnKey && turnStatus?.workedSeconds != null ? turnKey : undefined,
        // Liveness is the live turn's rows, not the newest prompt's: a running turn's rows stay live
        // while a newer message waits behind it. With no user boundary at all, the session's
        // working state stays authoritative.
        activeTurnIsWorking: enabled && isWorking && turnKey === liveTurnKey
      }
    },
    [
      turnKeys,
      waiting,
      liveTurnKey,
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
    resolveRow,
    listMessages: waiting.listMessages,
    waitingRows: waiting.waitingRows
  }
}
