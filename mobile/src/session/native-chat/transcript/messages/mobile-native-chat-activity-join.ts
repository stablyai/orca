// Two one-line rows that touch (`nativeChatActivityRowJoins`: item lines, an agent's update, waits,
// automation runs, Handed to, Memory updated) sit 3 pt apart, as the lines inside one item note do:
// the phone's match for the desktop's 6 px (`NATIVE_CHAT_ACTIVITY_ROW_GAP_PX`).
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatActivityJoin } from '../../../../../../src/shared/native-chat/transcript/events/native-chat-activity-rows'
import { spacing } from '../../../../theme/mobile-theme'

export const MOBILE_NATIVE_CHAT_ACTIVITY_ROW_GAP = 3

/** Pulls a row into its own vertical padding on its touching sides, leaving half the gap there. An
 *  item note row pads `xs`; every other one-line row sits in a message row's `sm`. */
export function mobileNativeChatActivityJoinMargins(
  join: NativeChatActivityJoin | undefined,
  message: NativeChatMessage
): { marginTop?: number; marginBottom?: number } {
  const pull =
    MOBILE_NATIVE_CHAT_ACTIVITY_ROW_GAP / 2 - (message.botItemNote ? spacing.xs : spacing.sm)
  return {
    ...(join === 'above' || join === 'both' ? { marginTop: pull } : {}),
    ...(join === 'below' || join === 'both' ? { marginBottom: pull } : {})
  }
}
