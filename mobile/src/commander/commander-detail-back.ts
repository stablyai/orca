import { createContext, useContext, useLayoutEffect, type RefObject } from 'react'

/** Only the visible detail may intercept Commander's Back action. The root retains the one native
 * or page-bridge registration, so restoring a tab cannot invert the parent/child Back order. */
export const CommanderDetailBack = createContext<RefObject<(() => void) | null> | null>(null)

export function useCommanderDetailBack(action: (() => void) | null): void {
  const slot = useContext(CommanderDetailBack)
  useLayoutEffect(() => {
    if (!slot || !action) {
      return
    }
    slot.current = action
    return () => {
      if (slot.current === action) {
        slot.current = null
      }
    }
  }, [slot, action])
}
