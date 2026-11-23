import { useSyncExternalStore } from 'react'

let failed = false
const listeners = new Set<() => void>()

export function setLiveActivityDeliveryFailed(value: boolean): void {
  if (failed === value) {
    return
  }
  failed = value
  for (const listener of listeners) {
    listener()
  }
}

export function useLiveActivityDeliveryFailed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => failed,
    () => false
  )
}
