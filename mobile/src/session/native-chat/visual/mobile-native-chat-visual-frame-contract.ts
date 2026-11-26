// The shell serves this fixed document (MobileWebShellChatVisualFrame on iOS and Android); it nests
// the first visual its parent posts and relays the parent's later messages to it.
export const MOBILE_NATIVE_CHAT_VISUAL_FRAME_PATH = '/chat-visual-frame'

export function mobileNativeChatVisualDocumentMessage(
  html: string,
  title: string
): { type: 'orca-visual-document'; html: string; title: string } {
  return { type: 'orca-visual-document', html, title }
}
