import { useSyncExternalStore } from 'react'

let failed = false
let cleanupPending = false
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

export function setLiveActivityCleanupPending(value: boolean): void {
  if (cleanupPending === value) {
    return
  }
  cleanupPending = value
  for (const listener of listeners) {
    listener()
  }
}

export function useLiveActivityCleanupPending(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => cleanupPending,
    () => false
  )
}
