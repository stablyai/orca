import { useEffect } from 'react'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'

// Give pages window insets like native screens, except status-bar space already consumed by the shell banner.
export function pageSafeAreaInsets(input: {
  insets: BridgeSafeAreaInsets
  topCovered: boolean
}): BridgeSafeAreaInsets {
  const { insets } = input
  return {
    top: input.topCovered ? 0 : insets.top,
    right: insets.right,
    bottom: insets.bottom,
    left: insets.left
  }
}

// Resend init when inset values change, not on every render, to handle rotation/banner changes.
export function usePublishedSafeAreaInsets(
  publish: (insets: BridgeSafeAreaInsets) => void,
  insets: BridgeSafeAreaInsets
): void {
  const { top, right, bottom, left } = insets
  useEffect(() => {
    publish({ top, right, bottom, left })
  }, [publish, top, right, bottom, left])
}
