import { useMemo } from 'react'
import {
  nativeChatActivityRowJoins,
  type NativeChatActivityJoin
} from '../../../../../../src/shared/native-chat/transcript/events/native-chat-activity-rows'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import {
  NATIVE_CHAT_EMPTY_TURN_FOLD,
  nativeChatTurnFold,
  nativeChatTurnFoldRow,
  type NativeChatTurnFold
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

function mobileNativeChatTurnFold({
  rows,
  turnKeys,
  receipts,
  settledTurnKeys,
  expandedTurnKeys
}: TranscriptRows & {
  settledTurnKeys: ReadonlySet<string>
  expandedTurnKeys: ReadonlySet<string>
}): NativeChatTurnFold {
  return nativeChatTurnFold({
    rows: rows.map((message, index) =>
      nativeChatTurnFoldRow(message, turnKeys[index], receipts?.get(message.id))
    ),
    settledTurnKeys,
    expandedTurnKeys
  })
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

export type MobileNativeChatTurnBars = {
  bars: ReadonlyMap<string, { index: number; above: boolean }>
  quiet: { ids: ReadonlySet<string>; turns: ReadonlySet<string> } | null
  active: NativeChatTurnStatus | null
  activeTurnKey: string | null | undefined
}

/** The rows that draw their turn's bar, and on which side: a turn with a status that isn't quiet. */
function mobileNativeChatBarSides(
  turnBars: MobileNativeChatTurnBars,
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
): Map<number, 'above' | 'below'> {
  const sides = new Map<number, 'above' | 'below'>()
  for (const [turnKey, bar] of turnBars.bars) {
    const status = turnKey === turnBars.activeTurnKey ? turnBars.active : completedByTurn[turnKey]
    if (status && !turnBars.quiet?.turns.has(turnKey)) {
      sides.set(bar.index, bar.above ? 'above' : 'below')
    }
  }
  return sides
}

const NO_TURN_BARS: MobileNativeChatTurnBars = {
  bars: new Map(),
  quiet: null,
  active: null,
  activeTurnKey: undefined
}
const NO_RECEIPTS: ReadonlyMap<string, NativeChatResolvedPrompt> = new Map()
const NO_WORK_RUNS: MobileNativeChatWorkRuns = { heads: new Map(), joined: new Set() }

// Fold/frontier/work-run projection applies only to structured turn rows.
export function useMobileNativeChatTranscriptRows({
  enabled,
  rows,
  turnKeys,
  receipts,
  completedByTurn,
  expandedTurnKeys,
  liveReasoningId,
  turnDiffs,
  turnBars: { bars, quiet, active, activeTurnKey } = NO_TURN_BARS
}: TranscriptRows & {
  enabled: boolean
  /** Turn diffs by the row they draw under (undefined: its turn changed nothing); one ends an
   *  item-note cluster there. */
  turnDiffs: ReadonlyMap<string, unknown>
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  expandedTurnKeys: ReadonlySet<string>
  liveReasoningId: string | undefined
  /** Where turn bars draw, and the rows and bars quiet turns hide; the bar keeps its side apart. */
  turnBars?: MobileNativeChatTurnBars
}): {
  fold: NativeChatTurnFold
  trailingRunIndex: number
  workRuns: MobileNativeChatWorkRuns
  /** Activity rows that touch another, past rows this projection hides. */
  activityJoins: ReadonlyMap<number, NativeChatActivityJoin>
} {
  const fold = useMemo(
    () =>
      enabled
        ? mobileNativeChatTurnFold({
            rows,
            turnKeys,
            receipts,
            settledTurnKeys: new Set(
              Object.entries(completedByTurn).flatMap(([turnKey, status]) =>
                status.workedSeconds != null ? [turnKey] : []
              )
            ),
            expandedTurnKeys
          })
        : NATIVE_CHAT_EMPTY_TURN_FOLD,
    [completedByTurn, enabled, expandedTurnKeys, receipts, rows, turnKeys]
  )
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
  const activityJoins = useMemo(() => {
    const barSides = enabled
      ? mobileNativeChatBarSides({ bars, quiet, active, activeTurnKey }, completedByTurn)
      : new Map<number, 'above' | 'below'>()
    return nativeChatActivityRowJoins(
      rows,
      (index) =>
        fold.foldedRows.has(index) ||
        workRuns.joined.has(index) ||
        quiet?.ids.has(rows[index]!.id) === true,
      (index) => ({
        above: barSides.get(index) === 'above',
        below: barSides.get(index) === 'below' || turnDiffs.get(rows[index]!.id) !== undefined
      })
    )
  }, [
    active,
    activeTurnKey,
    bars,
    completedByTurn,
    enabled,
    fold,
    quiet,
    rows,
    turnDiffs,
    workRuns
  ])
  return { fold, trailingRunIndex, workRuns, activityJoins }
}
