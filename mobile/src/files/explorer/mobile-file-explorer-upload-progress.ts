import { useSyncExternalStore } from 'react'

// Bytes sent per upload, apart from the queue, so a chunk repaints its own row and not the whole Files list.
const progress = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

export function setProgress(id: string, sent: number): void {
  progress.set(id, sent)
  for (const listener of listeners.get(id) ?? []) {
    listener()
  }
}

export function forgetProgress(id: string): void {
  progress.delete(id)
}

/** Bytes sent so far for one upload. */
export function useUploadProgress(id: string): number {
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(id) ?? new Set()
      set.add(listener)
      listeners.set(id, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) {
          listeners.delete(id)
        }
      }
    },
    () => progress.get(id) ?? 0,
    () => 0
  )
}
