import { createContext, useContext } from 'react'

export const BottomDrawerHostAfterCloseContext = createContext<(() => void) | null>(null)

export function useBottomDrawerHostAfterClose(): (() => void) | null {
  return useContext(BottomDrawerHostAfterCloseContext)
}

export const BottomDrawerHostCloseStartedContext = createContext<(() => void) | null>(null)

export function useBottomDrawerHostCloseStarted(): (() => void) | null {
  return useContext(BottomDrawerHostCloseStartedContext)
}

export const BottomDrawerHostCloseCancelledContext = createContext<(() => void) | null>(null)

export function useBottomDrawerHostCloseCancelled(): (() => void) | null {
  return useContext(BottomDrawerHostCloseCancelledContext)
}
