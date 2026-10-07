import { useCallback, useMemo } from 'react'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import {
  deriveNativeChatRowContent,
  nativeChatRowRendersContent
} from '../../../src/shared/native-chat-row-content'
import { nativeChatLiveLine } from '../../../src/shared/native-chat-live-line'
import {
  nativeChatTurnFold,
  nativeChatTurnAnswerRows
} from '../../../src/shared/native-chat-turn-fold'
import type { NativeChatSettledTurns } from '../../../src/shared/native-chat-turn-status'
import {
  isNativeChatRowInLiveWorkingTurn,
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../src/shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../src/shared/native-chat-messages-waiting-behind-live-turn'
import { nativeChatRowsInDrawOrder } from '../../../src/shared/native-chat-turn-grouping'
import { isStoppedBeforeStartBlock } from '../../../src/shared/native-chat-stopped-before-start'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../../../src/shared/agent-session-orca-stop'
import { useMobileNativeChatScopedOpenKeys } from './use-mobile-native-chat-scoped-open-keys'
import { useMobileNativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
export type {
  MobileNativeChatLiveLine,
  MobileNativeChatTurnRow
} from './mobile-native-chat-turn-disclosure-types'
const NO_TURN_KEYS: readonly undefined[] = []
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
  toolsExpanded = false,
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
  toolsExpanded?: boolean
  scopeKey: string
}) {
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
  const [expandedTurnIds, toggleExpandedTurn] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [expandedReasoning, toggleReasoning] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [openSubagentGroups, toggleSubagentGroup] = useMobileNativeChatScopedOpenKeys(scopeKey)
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
    const ids = nativeChatMessagesWaitingBehindLiveTurn(
      rows,
      turnJournal?.items,
      stopping,
      turnJournal?.submissions
    )
    const foldRows = rows.map((message, index) => {
      const content = deriveNativeChatRowContent(message.blocks)
      return {
        turnKey: turnKeys[index],
        role: message.role,
        rendersProse: content.markdown.length > 0 || content.hasImages,
        draws: nativeChatRowRendersContent(message.blocks),
        outlivesTurn: message.blocks.some(
          (block) =>
            isSubagentGroupBlock(block) ||
            isBackgroundTaskBlock(block) ||
            isStoppedBeforeStartBlock(block)
        ),
        reportsFailure: message.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.tone === 'error' &&
            block.presentation !== AGENT_SESSION_ORCA_STOP_PRESENTATION
        ),
        explainsTurn: message.blocks.some(
          (block) =>
            block.type === 'text' &&
            (block.presentation === 'compaction' ||
              block.presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION)
        )
      }
    })
    const settledTurnKeys = new Set(
      Object.entries(turnStatuses.completedByTurn)
        .filter(([, status]) => status.workedSeconds != null)
        .map(([turnKey]) => turnKey)
        .filter((turnKey) => !(isWorking && turnKey === liveTurnKey))
    )
    const { foldedRows: folded } = nativeChatTurnFold({
      rows: foldRows,
      settledTurnKeys,
      expandedTurnKeys: expandedTurnIds
    })
    const foldedRows = new Set(folded)
    if (toolsExpanded) {
      for (const [index, message] of rows.entries()) {
        if (
          foldedRows.has(index) &&
          message.blocks.some((block) => block.type === 'tool-call' || block.type === 'tool-result')
        ) {
          foldedRows.delete(index)
        }
      }
    }
    const carrierRows = new Set<number>()
    const firstRowByTurn = new Map<string, number>()
    const answerRows = nativeChatTurnAnswerRows(foldRows)
    for (const [index, row] of foldRows.entries()) {
      if (row.turnKey === undefined) {
        continue
      }
      if (!firstRowByTurn.has(row.turnKey)) {
        firstRowByTurn.set(row.turnKey, index)
      }
    }
    for (const [turnKey, index] of firstRowByTurn) {
      if (
        settledTurnKeys.has(turnKey) &&
        !answerRows.has(turnKey) &&
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
      const isQueuedUser = message.role === 'user' && message.id !== turnKey
      if (turnKey !== undefined && !isQueuedUser && !foldedRows.has(index) && !bars.has(turnKey)) {
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
  }, [
    enabled,
    isWorking,
    liveTurnKey,
    rows,
    stopping,
    toolsExpanded,
    turnJournal,
    turnKeys,
    turnStatuses.completedByTurn,
    expandedTurnIds
  ])
  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const inLiveWorkingTurn = useCallback(
    (index: number) =>
      isNativeChatRowInLiveWorkingTurn(turnKeys[index], liveTurnKey, enabled && isWorking),
    [enabled, isWorking, liveTurnKey, turnKeys]
  )
  const activeActivityText = enabled && isWorking ? (activityText ?? null) : null
  const line = useMemo(
    () =>
      nativeChatLiveLine({
        draws: enabled && isWorking && !lineYields && active !== null,
        thinking: active?.thinking === true,
        stopping,
        activityText: activeActivityText,
        messages: rows,
        inLiveWorkingTurn
      }),
    [active, activeActivityText, enabled, inLiveWorkingTurn, isWorking, lineYields, rows, stopping]
  )
  const liveLine = useMemo(
    () =>
      line && {
        ...line,
        reasoningExpanded:
          line.reasoning !== null &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(line.reasoning.message.id))
      },
    [expandedReasoning, line]
  )
  const latestAssistantId =
    waiting.listMessages.findLast((row) => row.role === 'assistant')?.id ?? null
  const resolveRow = useCallback(
    (listIndex: number, message: NativeChatMessage) => {
      const index = waiting.indexById.get(message.id) ?? listIndex
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? undefined : waiting.bars.get(turnKey)
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
        turnKey: turnKey && turnStatus?.workedSeconds != null ? turnKey : undefined,
        activeTurnIsWorking: inLiveWorkingTurn(index),
        mayStillGrow: !lineYields && message.id === latestAssistantId,
        reasoningIsLive: message.id === line?.reasoning?.message.id,
        reasoningExpanded:
          message.role === 'reasoning' &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(message.id)),
        onToggleReasoning: toggleReasoning,
        ...(message.blocks.some(isSubagentGroupBlock)
          ? { subagentGroupsOpen: openSubagentGroups }
          : {}),
        onToggleSubagentGroup: toggleSubagentGroup
      }
    },
    [
      turnKeys,
      waiting,
      enabled,
      activeTurnKey,
      active,
      completedByTurn,
      expandedTurnIds,
      inLiveWorkingTurn,
      latestAssistantId,
      lineYields,
      line,
      expandedReasoning,
      toggleReasoning,
      openSubagentGroups,
      toggleSubagentGroup
    ]
  )
  return {
    active,
    activeActivityText,
    onToggleTurn: toggleExpandedTurn,
    resolveRow,
    listMessages: waiting.listMessages,
    waitingRows: waiting.waitingRows,
    liveLine,
    onToggleReasoning: toggleReasoning
  }
}
