import { useMobileNativeChatGeneratedImageAnswers } from '../message-content/use-mobile-native-chat-generated-image-answers'
import { useMobileNativeChatTurnDiffs } from './use-mobile-native-chat-turn-diffs'
import type { MobileNativeChatTurnRow } from '../projection/use-mobile-native-chat-row-props'
import { useCallback, useMemo } from 'react'
import { nativeChatAutomationTurnKeys } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-automation-turns'
import { nativeChatActingTurnKeys } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-acting-turns'
import { useMobileNativeChatScopedOpenKeys } from './use-mobile-native-chat-scoped-open-keys'
import { foldBotItemNotes } from '../../../../../../src/shared/bots/bot-item-note-runs'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatReasoningDisclosureKey } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-reasoning-row'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-live-line'
import type {
  NativeChatSettledTurns,
  NativeChatTurnStatus
} from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-live-turn-membership'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../../../src/shared/native-chat/transcript/streaming/native-chat-streaming'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { useMobileNativeChatTranscriptRows } from './use-mobile-native-chat-transcript-rows'
import type { MobileNativeChatRunPresentation } from '../projection/mobile-native-chat-run-descriptors'
import {
  nativeChatRowsInDrawOrder,
  nativeChatTurnBarRows
} from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-grouping'
import { useMobileNativeChatTurnStatus } from './use-mobile-native-chat-turn-status'
import { mobileNativeChatQuietTurns } from './mobile-native-chat-quiet-turns'
import { structuredAgentTurnOpeningSendPending } from '../../../../../../src/shared/agent-session/view/structured-agent-session-turn-timing'

const NO_TURN_KEYS: readonly undefined[] = []

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
  const {
    rows: sourceRows,
    turnKeys,
    liveTurnKey,
    unresolvedRowIds,
    partialTurnKey
  } = useMemo(() => {
    if (!enabled) {
      return {
        rows: foldBotItemNotes(messages),
        turnKeys: NO_TURN_KEYS,
        liveTurnKey: undefined,
        unresolvedRowIds: undefined,
        partialTurnKey: undefined
      }
    }
    const membership = nativeChatTurnMembership(messages, turnJournal)
    const turnKeys = nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder)
    return {
      rows: foldBotItemNotes(nativeChatRowsInDrawOrder(messages, membership.drawOrder), turnKeys),
      turnKeys,
      liveTurnKey: membership.liveTurnKey,
      partialTurnKey: membership.partialTurnKey,
      unresolvedRowIds: membership.unresolvedRowIds
    }
  }, [enabled, messages, turnJournal])
  const turnStatuses = useMobileNativeChatTurnStatus({
    turnKeys,
    liveTurnKey,
    enabled,
    // The clock starts once the host has the opening message, as desktop's "Sending…" clears.
    isWorking:
      isWorking && !structuredAgentTurnOpeningSendPending(liveTurnKey, turnJournal?.submissions),
    workingStartedAt,
    settledTurns,
    thinking,
    scopeKey
  })
  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const rows = useMobileNativeChatGeneratedImageAnswers(
    enabled,
    sourceRows,
    turnKeys,
    completedByTurn
  )
  const summaries = useMobileNativeChatTurnDiffs(rows, enabled, turnKeys, partialTurnKey)
  const quiet = useMemo(
    () => (enabled ? mobileNativeChatQuietTurns(rows, turnKeys, completedByTurn, summaries) : null),
    [completedByTurn, enabled, rows, summaries, turnKeys]
  )
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
    if (!ids?.size && !quiet?.ids.size) {
      return { listMessages: rows, waitingRows: [], indexById: null }
    }
    return {
      // Rows merged into a later one are among the quiet ids, and draw inside it.
      listMessages: (quiet?.shown ?? rows).filter((m) => !ids?.has(m.id) && !quiet?.ids.has(m.id)),
      waitingRows: rows.flatMap((item, index) => (ids?.has(item.id) ? [{ item, index }] : [])),
      indexById: new Map(rows.map((message, index) => [message.id, index]))
    }
  }, [enabled, quiet, rows, stopping, turnJournal])
  const [expandedTurnIds, toggleExpandedTurn] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [expandedReasoning, toggleReasoning] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const [openUserMessages, toggleUserMessage] = useMobileNativeChatScopedOpenKeys(scopeKey)
  const bars = useMemo(() => nativeChatTurnBarRows(rows, turnKeys), [rows, turnKeys])
  const automationTurns = useMemo(
    () => nativeChatAutomationTurnKeys(rows, turnKeys),
    [rows, turnKeys]
  )
  const actingTurns = useMemo(() => nativeChatActingTurnKeys(rows, turnKeys), [rows, turnKeys])

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
  const { fold, trailingRunIndex, workRuns, itemNoteJoins } = useMobileNativeChatTranscriptRows({
    enabled,
    rows,
    turnKeys,
    receipts,
    completedByTurn,
    expandedTurnKeys: expandedTurnIds,
    liveReasoningId,
    turnDiffs: summaries
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
      const turnStatus =
        enabled && turnKey !== undefined && bar?.index === index && !quiet?.turns.has(turnKey)
          ? turnKey === activeTurnKey
            ? active
            : (completedByTurn[turnKey] ?? null)
          : null
      return {
        turnDiff: summaries.get(message.id),
        turnStatus,
        ...(bar?.above === true && turnStatus !== null ? { turnStatusAbove: true } : {}),
        turnExpanded: turnKey ? expandedTurnIds.has(turnKey) : false,
        // Pass row keys to one stable handler; per-row closures defeat memoization and render-time ref caches can leak discarded state.
        turnKey: turnKey && fold.foldableTurnKeys.has(turnKey) ? turnKey : undefined,
        ...(turnKey === message.id ? { opensTurn: true as const } : {}),
        ...(turnKey !== undefined && automationTurns.has(turnKey)
          ? { inAutomationTurn: true as const }
          : {}),
        ...(turnKey !== undefined && actingTurns.has(turnKey)
          ? { inActingTurn: true as const }
          : {}),
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
        ...(itemNoteJoins.has(index) ? { itemNoteJoin: itemNoteJoins.get(index) } : {}),
        mayStillGrow: !lineYields && message.id === latestAssistantId,
        reasoningIsLive: message.id === liveReasoningId,
        reasoningExpanded:
          message.role === 'reasoning' &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(message.id)),
        onToggleReasoning: toggleReasoning,
        userMessageOpen: message.role === 'user' && openUserMessages.has(message.id),
        onToggleUserMessage: toggleUserMessage
      }
    },
    [
      turnKeys,
      automationTurns,
      actingTurns,
      summaries,
      waiting,
      quiet,
      bars,
      enabled,
      activeTurnKey,
      active,
      completedByTurn,
      expandedTurnIds,
      inLiveWorkingTurn,
      trailingRunIndex,
      workRuns,
      itemNoteJoins,
      fold,
      rows,
      latestAssistantId,
      lineYields,
      liveReasoningId,
      expandedReasoning,
      toggleReasoning,
      isWorking,
      openUserMessages,
      toggleUserMessage
    ]
  )

  return {
    active,
    presentation,
    activeActivityText,
    onToggleTurn: toggleExpandedTurn,
    resolveRow,
    listMessages: waiting.listMessages,
    waitingRows: waiting.waitingRows,
    liveLine,
    onToggleReasoning: toggleReasoning
  }
}
