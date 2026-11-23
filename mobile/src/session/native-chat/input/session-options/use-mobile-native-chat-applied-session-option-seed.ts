import { useLayoutEffect, useRef } from 'react'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

export function useMobileNativeChatAppliedSessionOptionSeed(
  surface: NativeChatPtySessionOptionsSurface | null,
  appliedSessionOptions: Record<string, SessionOptionValue> | undefined
): void {
  const seededKeys = useRef(new WeakMap<NativeChatPtySessionOptionsSurface, string>())
  useLayoutEffect(() => {
    if (!surface || !appliedSessionOptions) {
      return
    }
    const key = JSON.stringify(appliedSessionOptions)
    if (seededKeys.current.get(surface) === key) {
      return
    }
    seededKeys.current.set(surface, key)
    const values = Object.fromEntries(
      Object.entries(appliedSessionOptions).filter(
        ([, value]) => typeof value === 'string' || typeof value === 'boolean'
      )
    )
    surface.mergeAppliedSessionOptions(values)
  }, [appliedSessionOptions, surface])
}
