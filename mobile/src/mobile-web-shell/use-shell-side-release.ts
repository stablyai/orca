import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailStrip } from '../layout/side-rail'
import { useClaimSideRelease } from '../layout/released-side-inset'

/** While this screen is focused on a Duo rail, leave the status column unpadded. */
export function useShellSideRelease(eligible: boolean): void {
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
