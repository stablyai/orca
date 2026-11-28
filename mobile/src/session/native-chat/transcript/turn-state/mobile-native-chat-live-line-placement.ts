import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatBotMessageCardOf } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import type { NativeChatLiveLine } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-live-line'
import { nativeChatReasoningDisclosureKey } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-reasoning-row'
import {
  describeNativeChatActiveTurnLabel,
  type NativeChatTurnStatus
} from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'

export type MobileNativeChatLiveLine = NativeChatLiveLine & {
  reasoningExpanded: boolean
  /** Right under the live turn's bar, across its line. */
  underTurnBar: boolean
}

/** Where the live line sits against the live turn's bar:
 *  - `apart`: rows lie between them, or no bar is drawn;
 *  - `under`: right under the bar, so the bar's line divides them;
 *  - `merged`: right under it with only the bare "Working…", which repeats the bar; the bar spins instead. */
export type MobileNativeChatLiveLinePlacement = 'apart' | 'under' | 'merged'

type BarFacts = {
  active: NativeChatTurnStatus | null
  activeTurnKey: string | null | undefined
  /** The row the live bar draws under: the turn's prompt, or the person's newest message mid-turn. */
  liveBarIndex: number | undefined
  quiet: { turns: ReadonlySet<string> } | null
  rows: readonly NativeChatMessage[]
  /** The rows the list draws; the live line comes right after the last. */
  listMessages: readonly NativeChatMessage[]
}

export function mobileNativeChatLiveLinePlacement(
  line: NativeChatLiveLine | null,
  { active, activeTurnKey, liveBarIndex, quiet, rows, listMessages }: BarFacts
): MobileNativeChatLiveLinePlacement {
  if (!line || !active || activeTurnKey == null || quiet?.turns.has(activeTurnKey)) {
    return 'apart'
  }
  const barRow = liveBarIndex === undefined ? undefined : rows[liveBarIndex]
  // Only a person's plain message draws the bar under itself; notices, automations and cards draw their own row.
  if (
    !barRow ||
    barRow.id !== listMessages.at(-1)?.id ||
    barRow.role !== 'user' ||
    barRow.orcaNotice ||
    barRow.automationRun ||
    barRow.automationRunNotStarted ||
    barRow.automationSaved ||
    barRow.waitEnded ||
    nativeChatBotMessageCardOf(barRow)
  ) {
    return 'apart'
  }
  const label = describeNativeChatActiveTurnLabel(line)
  return label.source === 'status' && label.key === 'working' && !line.reasoning
    ? 'merged'
    : 'under'
}

/** The live line to draw, or null while the bar stands in for it. */
export function useMobileNativeChatLiveLine(
  line: NativeChatLiveLine | null,
  expandedReasoning: ReadonlySet<string>,
  bar: BarFacts
): { liveLine: MobileNativeChatLiveLine | null; placement: MobileNativeChatLiveLinePlacement } {
  const placement = mobileNativeChatLiveLinePlacement(line, bar)
  const liveLine = useMemo<MobileNativeChatLiveLine | null>(
    () =>
      line && placement !== 'merged'
        ? {
            ...line,
            reasoningExpanded:
              line.reasoning !== null &&
              expandedReasoning.has(nativeChatReasoningDisclosureKey(line.reasoning.message.id)),
            underTurnBar: placement === 'under'
          }
        : null,
    [expandedReasoning, line, placement]
  )
  return { liveLine, placement }
}
