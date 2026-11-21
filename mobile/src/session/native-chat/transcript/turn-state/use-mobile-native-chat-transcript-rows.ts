import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  botItemNoteJoins,
  type BotItemNoteJoin
} from '../../../../../../src/shared/bots/bot-item-note-runs'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import {
  NATIVE_CHAT_EMPTY_TURN_FOLD,
  nativeChatHistoryTurnFold,
  nativeChatTurnFoldRow,
  type NativeChatTurnFold,
  type NativeChatTurnFoldHistory
} from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-turn-fold'
import {
  nativeChatRowRendersProse,
  nativeChatRowSpeaksOrActs
} from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-trailing-run'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  nativeChatWorkRunMember,
  nativeChatWorkRunSpans
} from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-work-run'

type TranscriptRows = {
  rows: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null | undefined
}

export type MobileNativeChatWorkRuns = {
  heads: ReadonlyMap<number, readonly NativeChatMessage[]>
  joined: ReadonlySet<number>
}

// Invisible thoughts neither join nor split work runs; visible thoughts stay inside the run.
function mobileNativeChatWorkRuns({
  rows,
  turnKeys,
  receipts,
  liveReasoningId
}: TranscriptRows & { liveReasoningId: string | undefined }): MobileNativeChatWorkRuns {
  const spans = nativeChatWorkRunSpans(
    rows.map((message, index) => ({
      // At the top level the live line owns the open thought.
      member: nativeChatWorkRunMember(message, receipts?.has(message.id) === true, false),
      draws:
        message.role !== 'reasoning' ||
        (message.id !== liveReasoningId &&
          deriveNativeChatRowContent(message.blocks).markdown.trim().length > 0),
      scope: turnKeys[index]
    }))
  )
  const heads = new Map<number, readonly NativeChatMessage[]>()
  const joined = new Set<number>()
  for (const [head, ...rest] of spans) {
    if (head === undefined) {
      continue
    }
    heads.set(
      head,
      [head, ...rest].flatMap((index) => rows[index] ?? [])
    )
    for (const index of rest) {
      joined.add(index)
    }
  }
  return { heads, joined }
}

const NO_RECEIPTS: ReadonlyMap<string, NativeChatResolvedPrompt> = new Map()
const NO_WORK_RUNS: MobileNativeChatWorkRuns = { heads: new Map(), joined: new Set() }

// Fold/frontier/work-run projection applies only to structured turn rows.
export function useMobileNativeChatTranscriptRows({
  enabled,
  scopeKey,
  historyHead,
  rows,
  turnKeys,
  receipts,
  completedByTurn,
  expandedTurnKeys,
  liveReasoningId,
  turnDiffs
}: TranscriptRows & {
  enabled: boolean
  scopeKey: string
  historyHead?: string
  /** Turn diffs by the row they draw under (undefined: its turn changed nothing); one ends an
   *  item-note cluster there. */
  turnDiffs: ReadonlyMap<string, unknown>
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  expandedTurnKeys: ReadonlySet<string>
  liveReasoningId: string | undefined
}): {
  fold: NativeChatTurnFold
  expandedTurnKeys: ReadonlySet<string>
  trailingRunIndex: number
  workRuns: MobileNativeChatWorkRuns
  itemNoteJoins: ReadonlyMap<number, BotItemNoteJoin>
} {
  const committedFold = useRef<NativeChatTurnFoldHistory | null>(null)
  const historyFold = useMemo(
    () =>
      enabled
        ? nativeChatHistoryTurnFold(committedFold.current, {
            scope: scopeKey,
            historyHead,
            messages: rows,
            rows: rows.map((message, index) =>
              nativeChatTurnFoldRow(message, turnKeys[index], receipts?.get(message.id))
            ),
            settledTurnKeys: new Set(
              Object.entries(completedByTurn).flatMap(([key, status]) =>
                status.workedSeconds != null ? [key] : []
              )
            ),
            expandedTurnKeys
          })
        : null,
    [enabled, scopeKey, historyHead, rows, turnKeys, receipts, completedByTurn, expandedTurnKeys]
  )
  useLayoutEffect(() => {
    committedFold.current = historyFold
  }, [historyFold])
  const fold = historyFold?.fold ?? NATIVE_CHAT_EMPTY_TURN_FOLD
  // The turn owns liveness: its frontier stays live between calls, while earlier runs are settled.
  const trailingRunIndex = useMemo(
    () =>
      enabled
        ? rows.findLastIndex((row) =>
            nativeChatRowSpeaksOrActs(row, nativeChatRowRendersProse(row), receipts ?? NO_RECEIPTS)
          )
        : -1,
    [enabled, receipts, rows]
  )
  const workRuns = useMemo(
    () =>
      enabled
        ? mobileNativeChatWorkRuns({ rows, turnKeys, receipts, liveReasoningId })
        : NO_WORK_RUNS,
    [enabled, liveReasoningId, receipts, rows, turnKeys]
  )
  const itemNoteJoins = useMemo(
    () =>
      botItemNoteJoins(
        rows,
        (index) => fold.foldedRows.has(index) || workRuns.joined.has(index),
        (index) => turnDiffs.get(rows[index]!.id) !== undefined
      ),
    [fold, rows, turnDiffs, workRuns]
  )
  return {
    fold,
    expandedTurnKeys: historyFold?.expandedTurnKeys ?? expandedTurnKeys,
    trailingRunIndex,
    workRuns,
    itemNoteJoins
  }
}
