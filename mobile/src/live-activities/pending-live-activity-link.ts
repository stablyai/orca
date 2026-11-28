import { useSyncExternalStore } from 'react'

let link: { id: string; scope?: string; session?: string; sequence: number } | null = null
const listeners = new Set<() => void>()

export function publishLiveActivityLink(id: string, scope?: string, session?: string): void {
  link = { id, scope, session, sequence: (link?.sequence ?? 0) + 1 }
  for (const listener of listeners) {
    listener()
  }
}

export function usePendingLiveActivityLink() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => link,
    () => null
  )
}
