import { createContext, useContext, useEffect, useRef } from 'react'

type BottomDrawerModalHostScope = {
  /** False only while a self-showing host is down; its drawers render nothing until it is up. */
  shown: boolean
  /** Keeps a self-showing host up; null when the caller owns `visible`. */
  hold: (() => () => void) | null
  claimBack: (dismiss: () => void) => () => void
}

export const BottomDrawerModalHostContext = createContext<BottomDrawerModalHostScope | null>(null)

// Inside shared BottomDrawerModalHost, skip per-drawer native Modal; host owns the sole window.
export function useBottomDrawerModalHost(): BottomDrawerModalHostScope | null {
  return useContext(BottomDrawerModalHostContext)
}

/** Back on the host's Modal reaches the host, not BackHandler; the newest claim takes it. */
export function useBottomDrawerModalHostBackClaim(dismiss: (() => void) | null): void {
  const claimBack = useContext(BottomDrawerModalHostContext)?.claimBack
  const latest = useRef(dismiss)
  useEffect(() => {
    latest.current = dismiss
  })
  const claimed = dismiss !== null
  useEffect(() => {
    if (!claimBack || !claimed) {
      return
    }
    return claimBack(() => latest.current?.())
  }, [claimBack, claimed])
}
