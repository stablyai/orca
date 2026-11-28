import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailStrip } from '../layout/side-rail'
import { useClaimSideRelease } from '../layout/released-side-inset'
import { BRIDGE_TERMINAL_KEY_RAIL_GRANT } from './bridge/native-capabilities/bridge-terminal-key'
import { useDuoChatWidthPublish } from './use-duo-chat-width-publish'

/** While this screen is focused on a Duo rail, leave the status column unpadded. */
export function useShellSideRelease(
  overlay: boolean,
  routeGrants: readonly string[],
  publishStorage: () => void
): void {
  useDuoChatWidthPublish(publishStorage)
  const eligible = !overlay && routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const strip = useSideRailStrip()
  useClaimSideRelease(eligible && focused && strip !== null)
}
