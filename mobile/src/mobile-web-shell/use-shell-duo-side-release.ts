import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailStrip } from '../layout/side-rail'
import { useClaimSideRelease } from '../layout/released-side-inset'
import { BRIDGE_TERMINAL_KEY_RAIL_GRANT } from './bridge/native-capabilities/bridge-terminal-key'

/** While this shell is focused, a Duo session page may lay its chat across the status column. */
export function useShellDuoSideRelease(overlay: boolean, routeGrants: readonly string[]): void {
  const [shellFocused, setShellFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setShellFocused(true)
      return () => setShellFocused(false)
    }, [])
  )
  const strip = useSideRailStrip()
  useClaimSideRelease(
    shellFocused &&
      strip !== null &&
      !overlay &&
      routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)
  )
}
