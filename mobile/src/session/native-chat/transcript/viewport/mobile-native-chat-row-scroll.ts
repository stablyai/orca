import { createContext, useLayoutEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatTurnRow } from '../projection/use-mobile-native-chat-row-props'

// The turn status bar's height (its minHeight), and the gap kept above the turn's start.
const TURN_STATUS_HEIGHT = 28
const TURN_START_MARGIN = 12

type TurnRowOf = (
  index: number,
  row: NativeChatMessage
) => Pick<MobileNativeChatTurnRow, 'turnStatus' | 'turnStatusAbove' | 'opensTurn'>

export type MobileNativeChatRowTarget = { index: number; viewOffset: number }

/** Where the reply at `replyIndex` is read from: its turn's status bar ("Worked for …") or first
 *  row below the prompt, else the reply itself. A bar drawn above a row is inside its native cell,
 *  but beside its tagged box on the page. */
export function mobileNativeChatTurnStartTarget(
  rows: readonly NativeChatMessage[],
  replyIndex: number,
  turnRowOf: TurnRowOf,
  barInsideCell: boolean
): MobileNativeChatRowTarget {
  const at = (index: number, viewOffset: number): MobileNativeChatRowTarget => ({
    index,
    viewOffset: index === 0 && barInsideCell ? 0 : viewOffset
  })
  for (let index = replyIndex; index >= 0; index -= 1) {
    const turn = turnRowOf(index, rows[index]!)
    if (turn.turnStatus && turn.turnStatusAbove) {
      return at(index, TURN_START_MARGIN + (barInsideCell ? 0 : TURN_STATUS_HEIGHT))
    }
    if (turn.turnStatus && index < replyIndex) {
      // The bar closes the prompt's row, so the turn starts at the next row's top.
      return at(index + 1, TURN_START_MARGIN + TURN_STATUS_HEIGHT)
    }
    if (turn.opensTurn) {
      return at(Math.min(index + 1, replyIndex), TURN_START_MARGIN)
    }
  }
  return at(replyIndex, TURN_START_MARGIN)
}

/** Scrolls the transcript so this row's turn starts at the top; absent outside a chat list. */
export const MobileNativeChatRowScrollContext = createContext<
  ((message: NativeChatMessage) => void) | null
>(null)

/** One stable action for every row, so a streamed revision re-renders no row's actions. */
export function useMobileNativeChatRowScroll(
  rows: readonly NativeChatMessage[],
  keyOf: (row: NativeChatMessage) => string,
  turnRowOf: TurnRowOf,
  scrollRowToTop: (target: MobileNativeChatRowTarget) => void
): (message: NativeChatMessage) => void {
  const latest = useRef({ rows, keyOf, turnRowOf, scrollRowToTop })
  useLayoutEffect(() => {
    latest.current = { rows, keyOf, turnRowOf, scrollRowToTop }
  })
  const [scroll] = useState(() => (message: NativeChatMessage) => {
    const { rows: shown, keyOf: key, turnRowOf: turnOf, scrollRowToTop: scrollTo } = latest.current
    const target = key(message)
    const index = shown.findIndex((row) => key(row) === target)
    if (index !== -1) {
      scrollTo(mobileNativeChatTurnStartTarget(shown, index, turnOf, Platform.OS !== 'web'))
    }
  })
  return scroll
}
