import { useCallback, useMemo, useState } from 'react'
import { isSubagentGroupBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../src/shared/native-chat-live-line'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  isNativeChatRowInLiveWorkingTurn,
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../src/shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../src/shared/native-chat-messages-waiting-behind-live-turn'
import { NATIVE_CHAT_STREAMING_ID } from '../../../src/shared/native-chat/native-chat-streaming'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { useMobileNativeChatTranscriptRows } from './use-mobile-native-chat-transcript-rows'
import type { MobileNativeChatRunPresentation } from './mobile-native-chat-run-descriptors'
import {
  nativeChatRowsInDrawOrder,
  nativeChatTurnBarRows
} from '../../../src/shared/native-chat-turn-grouping'
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
  /** The live frontier: the last row where the agent spoke or acted. Only its run is live. */
  trailingRun: boolean
  /** Desktop parity: an unbroken stretch of tool rows and finished thoughts draws as one run,
   *  at its first row. Set on that row: every member, in order. */
  workRun?: readonly NativeChatMessage[]
  /** A later member of a work run, which its first row draws. */
  joinsWorkRun?: boolean
  /** A settled turn folded behind its "Worked for" row hides every row but its answer. */
  foldedAway?: boolean
  /** The reasoning disclosures the reader opened, for the thoughts drawn inside a work run. */
  openReasoning?: ReadonlySet<string>
  /** The newest assistant row of a live turn with no prompt open: its last text may still grow. */
  mayStillGrow: boolean
  /** The live activity line discloses this open reasoning block, so its row draws nothing. */
  reasoningIsLive: boolean
  /** A reasoning row's disclosure, keyed like the live line's so an opened block stays open. */
  reasoningExpanded: boolean
  onToggleReasoning: (key: string) => void
  /** The roster groups the reader opened, by group id; set only on a row that carries one, so a
   *  toggle re-renders roster rows alone. */
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup: (groupId: string) => void
  /** A long message of yours the reader opened; held here so scrolling it away keeps it open. */
  userMessageOpen: boolean
  onToggleUserMessage: (messageId: string) => void
}

/** The live activity line, when it draws, and whether the reader opened the block it discloses. */
export type MobileNativeChatLiveLine = NativeChatLiveLine & { reasoningExpanded: boolean }

/** Keys the reader opened in this chat, bounded; another chat's never leak in. */
function useScopedOpenKeys(scopeKey: string): [ReadonlySet<string>, (key: string) => void] {
  const [state, setState] = useState<{ scopeKey: string; keys: ReadonlySet<string> }>(() => ({
    scopeKey,
    keys: new Set()
  }))
  const toggle = useCallback(
    (key: string) => {
      setState((current) => {
        const next = new Set(current.scopeKey === scopeKey ? current.keys : [])
        if (!next.delete(key)) {
          if (next.size >= MAX_EXPANDED_TURNS) {
            const oldest = next.values().next().value
            if (oldest) {
              next.delete(oldest)
            }
          }
          next.add(key)
        }
        return { scopeKey, keys: next }
      })
    },
    [scopeKey]
  )
  return [state.scopeKey === scopeKey ? state.keys : EMPTY_TURN_IDS, toggle]
}

/** Owns the transcript's per-turn status rows and their disclosure state, and
 *  resolves what one list row needs. Bridge-lane chats pass `enabled: false`: no turn
 *  rows, but the same live "Working…" line while the agent works. */
export function useMobileNativeChatTurnDisclosure({
  messages,
  enabled,
  isWorking,
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  thinking = false,
  activityText = null,
  stopping = false,
  lineYields = false,
  receipts,
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
  /** A person's Stop is ending the live turn: the sends the host holds draw after its status. */
  stopping?: boolean
  /** A prompt the reader must answer replaces the live activity line. */
  lineYields?: boolean
  /** Resolved prompts by row; an approval's receipt does not move the agent past its run. */
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  /** Host/worktree/tab identity for timing and disclosure isolation. */
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  presentation: MobileNativeChatRunPresentation
  /** The live turn's provider activity copy, for the footer row. */
  activeActivityText: string | null
  onToggleTurn: (turnKey: string) => void
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
  /** The list's rows, in the order they draw, less those waiting behind the live turn. */
  listMessages: readonly NativeChatMessage[]
  /** Rows waiting behind the live turn, drawn after its live status. */
  waitingRows: readonly { item: NativeChatMessage; index: number }[]
  /** The live activity line, or null while the turn is idle or a prompt replaces it. */
  liveLine: MobileNativeChatLiveLine | null
  /** Stable for a given chat scope, so it never disturbs a row's memo. */
  onToggleReasoning: (key: string) => void
} {
  // Resolve each row's turn, which turn is live, and the order the rows draw in, once: from the
  // turn record when the host states scopes, else by journal order.
  const { rows, turnKeys, liveTurnKey, unresolvedRowIds } = useMemo(() => {
    if (!enabled) {
      return {
        rows: messages,
        turnKeys: NO_TURN_KEYS,
        liveTurnKey: undefined,
        unresolvedRowIds: undefined
      }
    }
    const membership = nativeChatTurnMembership(messages, turnJournal)
    return {
      rows: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
      turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
      liveTurnKey: membership.liveTurnKey,
      unresolvedRowIds: membership.unresolvedRowIds
    }
  }, [enabled, messages, turnJournal])
  // A message waiting behind the live turn draws after that turn's live status, not in the list.
  const waiting = useMemo(() => {
    const ids = enabled
      ? nativeChatMessagesWaitingBehindLiveTurn(
          rows,
          turnJournal?.items,
          stopping,
          turnJournal?.submissions,
          turnJournal ?? {}
        )
      : null
    if (!ids?.size) {
      return { listMessages: rows, waitingRows: [], indexById: null }
    }
    return {
      listMessages: rows.filter((message) => !ids.has(message.id)),
      waitingRows: rows.flatMap((item, index) => (ids.has(item.id) ? [{ item, index }] : [])),
      indexById: new Map(rows.map((message, index) => [message.id, index]))
    }
  }, [enabled, rows, stopping, turnJournal])
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
  const [expandedTurnIds, toggleExpandedTurn] = useScopedOpenKeys(scopeKey)
  const [expandedReasoning, toggleReasoning] = useScopedOpenKeys(scopeKey)
  const [openSubagentGroups, toggleSubagentGroup] = useScopedOpenKeys(scopeKey)
  const [openUserMessages, toggleUserMessage] = useScopedOpenKeys(scopeKey)
  const bars = useMemo(() => nativeChatTurnBarRows(rows, turnKeys), [rows, turnKeys])

  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const inLiveWorkingTurn = useCallback(
    (index: number) =>
      isNativeChatRowInLiveWorkingTurn(
        turnKeys[index],
        liveTurnKey,
        enabled && isWorking,
        unresolvedRowIds?.has(rows[index]!.id)
      ),
    [enabled, isWorking, liveTurnKey, turnKeys, unresolvedRowIds, rows]
  )
  const activeActivityText = enabled && isWorking ? (activityText ?? null) : null
  const line = useMemo(
    () =>
      nativeChatLiveLine({
        draws: isWorking && !lineYields && (!enabled || active !== null),
        thinking: active?.thinking === true,
        stopping,
        activityText: activeActivityText,
        messages: rows,
        inLiveWorkingTurn
      }),
    [active, activeActivityText, enabled, inLiveWorkingTurn, isWorking, lineYields, rows, stopping]
  )
  const liveReasoningId = line?.reasoning?.message.id
  const liveLine = useMemo<MobileNativeChatLiveLine | null>(
    () =>
      line && {
        ...line,
        reasoningExpanded:
          line.reasoning !== null &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(line.reasoning.message.id))
      },
    [expandedReasoning, line]
  )
  const { fold, trailingRunIndex, workRuns } = useMobileNativeChatTranscriptRows({
    enabled,
    rows,
    turnKeys,
    receipts,
    completedByTurn,
    expandedTurnKeys: expandedTurnIds,
    liveReasoningId
  })
  const presentation = useMemo(
    () => ({ rows, workRuns, turnKeys, receipts }),
    [rows, workRuns, turnKeys, receipts]
  )
  const latestAssistantId = useMemo(
    () => waiting.listMessages.findLast((row) => row.role === 'assistant')?.id ?? null,
    [waiting.listMessages]
  )
  const resolveRow = useCallback(
    (listIndex: number, message: NativeChatMessage): MobileNativeChatTurnRow => {
      const index = waiting.indexById?.get(message.id) ?? listIndex
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? undefined : bars.get(turnKey)
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
        // Offered only where the fold hides something, as on desktop.
        turnKey: turnKey && fold.foldableTurnKeys.has(turnKey) ? turnKey : undefined,
        ...(fold.foldedRows.has(index) ? { foldedAway: true } : {}),
        // With no user boundary at all, the session's working state stays authoritative. The bridge
        // lane has no turns: only its synthetic streaming row is known to be in the live one.
        activeTurnIsWorking: enabled
          ? inLiveWorkingTurn(index)
          : isWorking && message.id === NATIVE_CHAT_STREAMING_ID,
        trailingRun:
          index === trailingRunIndex ||
          (workRuns.heads.get(index)?.includes(rows[trailingRunIndex]!) ?? false),
        ...(workRuns.heads.has(index)
          ? { workRun: workRuns.heads.get(index), openReasoning: expandedReasoning }
          : {}),
        ...(workRuns.joined.has(index) ? { joinsWorkRun: true } : {}),
        mayStillGrow: !lineYields && message.id === latestAssistantId,
        reasoningIsLive: message.id === liveReasoningId,
        reasoningExpanded:
          message.role === 'reasoning' &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(message.id)),
        onToggleReasoning: toggleReasoning,
        ...(message.blocks.some(isSubagentGroupBlock)
          ? { subagentGroupsOpen: openSubagentGroups }
          : {}),
        onToggleSubagentGroup: toggleSubagentGroup,
        userMessageOpen: message.role === 'user' && openUserMessages.has(message.id),
        onToggleUserMessage: toggleUserMessage
      }
    },
    [
      turnKeys,
      waiting,
      bars,
      enabled,
      activeTurnKey,
      active,
      completedByTurn,
      expandedTurnIds,
      inLiveWorkingTurn,
      trailingRunIndex,
      workRuns,
      fold,
      rows,
      latestAssistantId,
      lineYields,
      liveReasoningId,
      expandedReasoning,
      toggleReasoning,
      openSubagentGroups,
      toggleSubagentGroup,
      isWorking,
      openUserMessages,
      toggleUserMessage
    ]
  )

  return {
    active,
    presentation,
    activeActivityText,
    /** Stable for a given chat scope, so it never disturbs a row's memo. */
    onToggleTurn: toggleExpandedTurn,
    resolveRow,
    listMessages: waiting.listMessages,
    waitingRows: waiting.waitingRows,
    liveLine,
    onToggleReasoning: toggleReasoning
  }
}
