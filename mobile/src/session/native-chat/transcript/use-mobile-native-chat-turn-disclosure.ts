import { useCallback, useMemo } from 'react'
import { useMobileNativeChatScopedOpenKeys } from './mobile-native-chat-disclosure-store'
import {
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../../../src/shared/native-chat-types'
import { nativeChatReasoningDisclosureKey } from '../../../../../src/shared/native-chat/transcript/native-chat-reasoning-row'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../src/shared/native-chat/transcript/native-chat-live-line'
import type {
  NativeChatSettledTurns,
  NativeChatTurnStatus
} from '../../../../../src/shared/native-chat-turn-status'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../src/shared/native-chat-live-turn-membership'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../../src/shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../src/shared/native-chat-messages-waiting-behind-live-turn'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../../src/shared/native-chat/native-chat-streaming'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat-resolution-receipt'
import { useMobileNativeChatTranscriptRows } from './use-mobile-native-chat-transcript-rows'
import type { MobileNativeChatRunPresentation } from '../../mobile-native-chat-run-descriptors'
import {
  nativeChatRowsInDrawOrder,
  nativeChatTurnBarRows
} from '../../../../../src/shared/native-chat/transcript/native-chat-turn-grouping'
import { useMobileNativeChatTurnStatus } from './use-mobile-native-chat-turn-status'

const NO_TURN_KEYS: readonly undefined[] = []

export type MobileNativeChatTurnRow = {
  turnStatus: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded: boolean
  turnKey?: string
  activeTurnIsWorking: boolean
  trailingRun: boolean
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
  foldedAway?: boolean
  openReasoning?: ReadonlySet<string>
  mayStillGrow: boolean
  reasoningIsLive: boolean
  reasoningExpanded: boolean
  onToggleReasoning: (key: string) => void
  // Pass roster disclosure only to roster rows so toggles cannot rerender every transcript row.
  subagentGroupsOpen?: ReadonlySet<string>
  onToggleSubagentGroup: (groupId: string) => void
  // Hold expanded user messages above recycled rows so scrolling away cannot collapse them.
  userMessageOpen: boolean
  onToggleUserMessage: (messageId: string) => void
}

export type MobileNativeChatLiveLine = NativeChatLiveLine & { reasoningExpanded: boolean }

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
  settledTurns?: NativeChatSettledTurns | null
  turnJournal?: NativeChatTurnJournal | null
  thinking?: boolean
  activityText?: string | null
  stopping?: boolean
  lineYields?: boolean
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  presentation: MobileNativeChatRunPresentation
  activeActivityText: string | null
  onToggleTurn: (turnKey: string) => void
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
  listMessages: readonly NativeChatMessage[]
  waitingRows: readonly { item: NativeChatMessage; index: number }[]
  liveLine: MobileNativeChatLiveLine | null
  onToggleReasoning: (key: string) => void
} {
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
  const [expandedTurnIds, toggleExpandedTurn] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [expandedReasoning, toggleReasoning] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [openSubagentGroups, toggleSubagentGroup] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [openUserMessages, toggleUserMessage] = useMobileNativeChatScopedOpenKeys(scopeKey)
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
  const {
    fold,
    expandedTurnKeys: historyExpandedTurns,
    trailingRunIndex,
    workRuns
  } = useMobileNativeChatTranscriptRows({
    enabled,
    scopeKey,
    historyHead: turnJournal?.items[0]?.itemId,
    rows,
    turnKeys,
    receipts,
    completedByTurn,
    expandedTurnKeys: expandedTurnIds,
    liveReasoningId
  })
  const toggleHistoryTurn = useCallback(
    (key: string) => toggleExpandedTurn(key, historyExpandedTurns),
    [toggleExpandedTurn, historyExpandedTurns]
  )
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
      const turnStatus =
        enabled && turnKey !== undefined && bar?.index === index
          ? turnKey === activeTurnKey
            ? active
            : (completedByTurn[turnKey] ?? null)
          : null
      return {
        turnStatus,
        ...(bar?.above === true && turnStatus !== null ? { turnStatusAbove: true } : {}),
        turnExpanded: turnKey ? historyExpandedTurns.has(turnKey) : false,
        // Pass row keys to one stable handler; per-row closures defeat memoization and render-time ref caches can leak discarded state.
        turnKey: turnKey && fold.foldableTurnKeys.has(turnKey) ? turnKey : undefined,
        ...(fold.foldedRows.has(index) ? { foldedAway: true } : {}),
        // Without a user boundary, session working state remains authoritative; bridge chat knows only its synthetic stream row is live.
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
      historyExpandedTurns,
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
    onToggleTurn: toggleHistoryTurn,
    resolveRow,
    listMessages: waiting.listMessages,
    waitingRows: waiting.waitingRows,
    liveLine,
    onToggleReasoning: toggleReasoning
  }
}
