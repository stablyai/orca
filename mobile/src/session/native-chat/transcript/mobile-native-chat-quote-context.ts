import { createContext } from 'react'

/** Adds reply text to the composer as a quote; absent while the composer cannot take it. */
export const MobileNativeChatQuoteContext = createContext<((text: string) => void) | undefined>(
  undefined
)
