import { useLayoutEffect } from 'react'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/input/composer/native-chat-scope-cache'

// Kept across remounts: refilling the same launch values would bring back a value the chat cleared on purpose.
const filledByChat = new Map<string, string>()

export function useMobileNativeChatAppliedSessionOptionSeed(
  surface: NativeChatPtySessionOptionsSurface | null,
  chatIdentity: string | null,
  appliedSessionOptions: Record<string, SessionOptionValue> | undefined
): void {
  useLayoutEffect(() => {
    if (!surface || !chatIdentity || !appliedSessionOptions) {
      return
    }
    const values = Object.fromEntries(
      Object.entries(appliedSessionOptions).filter(
        ([, value]) => typeof value === 'string' || typeof value === 'boolean'
      )
    )
    const key = JSON.stringify(values)
    if (filledByChat.get(chatIdentity) === key) {
      return
    }
    setBoundedScopeCacheEntry(filledByChat, chatIdentity, key)
    surface.fillAppliedSessionOptions(values)
  }, [appliedSessionOptions, chatIdentity, surface])
}
