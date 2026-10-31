import type { ViewStyle } from 'react-native'
import { useReleasedSideInset, type ReleasedSideInset } from '../layout/released-side-inset'

/**
 * Where the session keeps clear of a released side strip (the iPhone Duo's status column). With a
 * docked panel the whole row stays clear; otherwise each piece does, so the chat alone can fill it.
 */
export function useSessionSideStripInset(dockOpen: boolean): {
  row: ReleasedSideInset | null
  main: ReleasedSideInset | null
} {
  const released = useReleasedSideInset()
  return dockOpen ? { row: released, main: null } : { row: null, main: released }
}

export function sideStripMargin(inset: ReleasedSideInset | null): ViewStyle | null {
  if (inset === null) {
    return null
  }
  return inset.side === 'right' ? { marginRight: inset.width } : { marginLeft: inset.width }
}

export function sideStripPadding(inset: ReleasedSideInset | null): ViewStyle | null {
  if (inset === null) {
    return null
  }
  return inset.side === 'right' ? { paddingRight: inset.width } : { paddingLeft: inset.width }
}

/** For an absolute layer filling its parent, minus the strip. */
export function sideStripOffset(inset: ReleasedSideInset | null): ViewStyle | null {
  if (inset === null) {
    return null
  }
  return inset.side === 'right' ? { right: inset.width } : { left: inset.width }
}
