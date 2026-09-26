import { createContext, useContext } from 'react'

export const BottomDrawerHostAfterCloseContext = createContext<(() => void) | null>(null)

export function useBottomDrawerHostAfterClose(): (() => void) | null {
  return useContext(BottomDrawerHostAfterCloseContext)
}

export const BottomDrawerHostCloseCancelledContext = createContext<(() => void) | null>(null)

export function useBottomDrawerHostCloseCancelled(): (() => void) | null {
  return useContext(BottomDrawerHostCloseCancelledContext)
}
