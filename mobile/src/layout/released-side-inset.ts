import { createContext, useContext, useEffect } from 'react'

/** A side inset left unpadded so one screen can lay itself out across it, e.g. the iPhone Duo's status column. */
export type ReleasedSideInset = { side: 'left' | 'right'; width: number }

export const ReleasedSideInsetContext = createContext<ReleasedSideInset | null>(null)

/** The side inset this screen must pad for itself, or null when `SideSafeArea` already did. */
export function useReleasedSideInset(): ReleasedSideInset | null {
  return useContext(ReleasedSideInsetContext)
}

/** Lets a focused screen ask the enclosing `SideSafeArea` to leave the strip side unpadded. */
export const SideReleaseClaimContext = createContext<((claimed: boolean) => () => void) | null>(
  null
)

export function useClaimSideRelease(active: boolean): void {
  const claim = useContext(SideReleaseClaimContext)
  useEffect(() => (claim && active ? claim(true) : undefined), [claim, active])
}
