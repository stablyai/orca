import { createContext } from 'react'

// Hold below-reader growth during scrolling because corrective writes stop iOS flings; notify only growing rows.
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
