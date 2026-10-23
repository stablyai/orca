import { createContext } from 'react'

/** Whether rows may grow now. The page's list holds growth while a reader who scrolled up is
 *  moving: growth below them would push the line they read, and correcting it mid-fling stops the
 *  fling. A store, so holding re-renders only the rows that would grow. */
export type MobileNativeChatGrowthHold = {
  held: () => boolean
  subscribe: (onChange: () => void) => () => void
}

export function createMobileNativeChatGrowthHold(): MobileNativeChatGrowthHold & {
  set: (held: boolean) => void
} {
  let held = false
  const listeners = new Set<() => void>()
  return {
    held: () => held,
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    set: (next) => {
      if (next !== held) {
        held = next
        listeners.forEach((onChange) => onChange())
      }
    }
  }
}

const NEVER_HELD: MobileNativeChatGrowthHold = { held: () => false, subscribe: () => () => {} }

export const MobileNativeChatGrowthHoldContext =
  createContext<MobileNativeChatGrowthHold>(NEVER_HELD)
