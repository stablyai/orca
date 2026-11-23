import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'

export function createMobileNativeChatLandedPrompt() {
  let key: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const set = (next: string | undefined) => {
    if (key !== next) {
      key = next
      listeners.forEach((listener) => listener())
    }
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    has: (rowKey: string) => key === rowKey,
    show: (next: string | undefined) => {
      clearTimeout(timer)
      set(next)
      timer = next === undefined ? undefined : setTimeout(() => set(undefined), 700)
    }
  }
}

export const MobileNativeChatLandedPromptContext = createContext<ReturnType<
  typeof createMobileNativeChatLandedPrompt
> | null>(null)

const unsubscribe = () => {}
const skipSubscribe = () => unsubscribe
const noHighlight = () => false

export function useMobileNativeChatLandedPrompt(rowKey: string | undefined): boolean {
  const store = useContext(MobileNativeChatLandedPromptContext)
  const has = useCallback(
    () => rowKey !== undefined && store?.has(rowKey) === true,
    [rowKey, store]
  )
  return useSyncExternalStore(rowKey && store ? store.subscribe : skipSubscribe, has, noHighlight)
}
