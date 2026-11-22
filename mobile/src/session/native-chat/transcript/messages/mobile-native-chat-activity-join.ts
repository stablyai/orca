// Two activity rows that touch (item lines, a worker's update, a Started row) sit 2 pt apart, as the
// lines inside one item note do: 1 pt on each touching side (`nativeChatActivityRowJoins`).
import { createContext } from 'react'
import type { NativeChatActivityJoin } from '../../../../../../src/shared/native-chat/transcript/events/native-chat-activity-rows'
import { spacing } from '../../../../theme/mobile-theme'

/** The sides where a row's activity row touches another, set where rows are laid out. */
export const MobileNativeChatActivityJoinContext = createContext<
  NativeChatActivityJoin | undefined
>(undefined)

/** Pulls an activity row into its row's vertical padding (`rowPadding`) on its touching sides,
 *  leaving 1 pt there. */
export function mobileNativeChatActivityJoinMargins(
  join: NativeChatActivityJoin | undefined,
  rowPadding: number
): { marginTop?: number; marginBottom?: number } {
  const pull = spacing.xxs / 2 - rowPadding
  return {
    ...(join === 'above' || join === 'both' ? { marginTop: pull } : {}),
    ...(join === 'below' || join === 'both' ? { marginBottom: pull } : {})
  }
}
