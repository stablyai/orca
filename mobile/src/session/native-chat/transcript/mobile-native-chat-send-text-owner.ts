import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from '../mobile-native-chat-pending-echo'

type Restore = (
  origin: MobileNativeChatSendOrigin,
  text: string,
  options?: { preserveConversationCommands?: boolean }
) => void

/** Who gets a send's text back if it doesn't land: the composer for a typed send, its queue for a queued one. */
export function nativeChatSendTextOwner(
  intent: MobileNativeChatSendIntent | undefined,
  restore: Restore | null
) {
  return {
    // Text that lives nowhere else is saved in flight and handed back.
    owned: restore !== null || intent?.queued !== undefined,
    skillOrigin: intent?.queued?.skillOrigin,
    giveBack: (...args: Parameters<Restore>) => {
      restore?.(...args)
      intent?.onHandBack?.()
    }
  }
}
