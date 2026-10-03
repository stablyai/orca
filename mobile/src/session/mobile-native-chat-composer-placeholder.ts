import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import type { MobileNativeChatInputLockReason } from './MobileNativeChatView'

/** The chat composer's placeholder: why it is locked, else that a message sent now runs after a
 *  Stop the chat reads as stopping, else the usual prompt. */
export function mobileNativeChatComposerPlaceholder(
  lockReason: MobileNativeChatInputLockReason | null,
  /** While stopping: whether a message sent now is queued, or sent for the host to hold. */
  afterStop: 'queue' | 'send' | undefined
): string {
  if (lockReason === 'disconnected') {
    return 'Reconnecting…'
  }
  if (lockReason === 'waiting') {
    return 'Waiting for terminal…'
  }
  if (afterStop) {
    return afterStop === 'queue'
      ? NATIVE_CHAT_TURN_STATUS_COPY.queueAfterStop
      : NATIVE_CHAT_TURN_STATUS_COPY.sendAfterStop
  }
  return 'Message, @files, /commands'
}
