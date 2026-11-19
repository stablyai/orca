import { nativeChatPendingSendPlacement } from '../../../../../../src/shared/native-chat/transcript/pending-sends/native-chat-pending-sends'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

export type PlacedMobileNativeChatPendingMessage = MobileNativeChatPendingMessage & {
  pendingSend: 'active' | 'queued'
}

/** Tags each phone-local pending echo with where its send sits in the active turn. */
export function placeMobileNativeChatPendingSends(
  pending: readonly MobileNativeChatPendingMessage[],
  workingEpoch?: number | null
): PlacedMobileNativeChatPendingMessage[] {
  return pending.map((entry) => ({
    ...entry,
    pendingSend: nativeChatPendingSendPlacement(entry, workingEpoch)
  }))
}
