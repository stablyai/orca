import {
  nativeChatFontScale,
  useNativeChatTextSettings
} from '../../session/native-chat/preferences/native-chat-text-settings'
import { CHAT_PROSE_SCALE } from '../../session/native-chat/transcript/messages/mobile-native-chat-message-styles'

/** An item's comments read at chat's prose size in the system face, following the chat text size setting. */
export function useBotItemProseScale(): number {
  return CHAT_PROSE_SCALE * nativeChatFontScale(useNativeChatTextSettings().size)
}
