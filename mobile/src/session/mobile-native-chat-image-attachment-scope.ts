import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

export const NO_MOBILE_NATIVE_CHAT_ATTACHMENTS: PendingNativeChatImage[] = []

export function withMobileNativeChatScopeAttachments(
  byScope: Record<string, PendingNativeChatImage[]>,
  scope: string,
  next: PendingNativeChatImage[]
): Record<string, PendingNativeChatImage[]> {
  if (next.length > 0) {
    return { ...byScope, [scope]: next }
  }
  const remaining = { ...byScope }
  delete remaining[scope]
  return remaining
}
