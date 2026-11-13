import { useSyncExternalStore } from 'react'

let worktrees: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

export function setSleepingMailWorktrees(ids: readonly string[]): void {
  worktrees = new Set(ids)
  for (const listener of listeners) {
    listener()
  }
}

export function useHasSleepingMail(worktreeId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => worktrees.has(worktreeId)
  )
}
