import { useLayoutEffect } from 'react'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

export function useMobileNativeChatAppliedSessionOptionSeed(
  surface: NativeChatPtySessionOptionsSurface | null,
  appliedSessionOptions: Record<string, SessionOptionValue> | undefined
): void {
  useLayoutEffect(() => {
    if (!surface || !appliedSessionOptions) {
      return
    }
    const values = Object.fromEntries(
      Object.entries(appliedSessionOptions).filter(
        ([, value]) => typeof value === 'string' || typeof value === 'boolean'
      )
    )
    surface.fillAppliedSessionOptions(values)
  }, [appliedSessionOptions, surface])
}
