import { useSyncExternalStore } from 'react'
import {
  applySleepingMailChange,
  type SleepingMailChange
} from '../../../shared/workspace/lifecycle/sleeping-mail-change'

const worktrees = new Set<string>()
const listenersByWorktree = new Map<string, Set<() => void>>()

/** A change notifies only the cards of the workspaces it names; a whole set notifies every card. */
export function applySleepingMailWorktrees(change: SleepingMailChange): void {
  const changed = applySleepingMailChange(worktrees, change)
  const notified = changed === 'all' ? listenersByWorktree.keys() : changed
  for (const worktreeId of notified) {
    for (const listener of listenersByWorktree.get(worktreeId) ?? []) {
      listener()
    }
  }
}

export function useHasSleepingMail(worktreeId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const listeners = listenersByWorktree.get(worktreeId) ?? new Set()
      listenersByWorktree.set(worktreeId, listeners.add(listener))
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          listenersByWorktree.delete(worktreeId)
        }
      }
    },
    () => worktrees.has(worktreeId),
    () => false
  )
}
