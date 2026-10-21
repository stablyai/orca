import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

export const NO_NATIVE_CHAT_IMAGE_ATTACHMENTS: PendingNativeChatImage[] = []

export type MobileNativeChatImagesByScope = Record<string, PendingNativeChatImage[]>

/** One scope's list replaced, and the scope dropped once its list is empty. */
export function withScopeAttachments<List extends readonly unknown[]>(
  byScope: Readonly<Record<string, List>>,
  scope: string,
  next: List
): Record<string, List> {
  if (next.length > 0) {
    return { ...byScope, [scope]: next }
  }
  const remaining = { ...byScope }
  delete remaining[scope]
  return remaining
}
