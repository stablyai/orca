import type { Worktree } from '../worktree/workspace-list-sections'
import { sortWorktrees } from '../worktree/workspace-list-sections'

export function getKeyboardNavigableWorktrees(
  worktrees: readonly Worktree[],
  order: 'smart' | 'provided' = 'smart'
): Worktree[] {
  const seen = new Set<string>()
  const unique = worktrees.filter((worktree) => {
    if (worktree.isArchived || seen.has(worktree.worktreeId)) {
      return false
    }
    seen.add(worktree.worktreeId)
    return true
  })
  return order === 'provided' ? unique : sortWorktrees(unique, 'smart')
}

export function getRelativeKeyboardWorktree(
  worktrees: readonly Worktree[],
  currentWorktreeId: string | undefined,
  direction: -1 | 1,
  order: 'smart' | 'provided' = 'smart'
): Worktree | null {
  const ordered = getKeyboardNavigableWorktrees(worktrees, order)
  if (ordered.length === 0) {
    return null
  }
  const currentIndex = ordered.findIndex((worktree) => worktree.worktreeId === currentWorktreeId)
  const start = currentIndex === -1 ? (direction > 0 ? -1 : 0) : currentIndex
  return ordered[(start + direction + ordered.length) % ordered.length] ?? null
}

export function getIndexedKeyboardWorktree(
  worktrees: readonly Worktree[],
  oneBasedIndex: number,
  order: 'smart' | 'provided' = 'smart'
): Worktree | null {
  if (!Number.isInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > 9) {
    return null
  }
  return getKeyboardNavigableWorktrees(worktrees, order)[oneBasedIndex - 1] ?? null
}

export class MobileWorktreeNavigationHistory {
  private entries: string[] = []
  private index = -1

  record(worktreeId: string): void {
    if (this.entries[this.index] === worktreeId) {
      return
    }
    this.entries = [...this.entries.slice(0, this.index + 1), worktreeId]
    this.index = this.entries.length - 1
  }

  back(): string | null {
    if (this.index <= 0) {
      return null
    }
    this.index -= 1
    return this.entries[this.index] ?? null
  }

  forward(): string | null {
    if (this.index >= this.entries.length - 1) {
      return null
    }
    this.index += 1
    return this.entries[this.index] ?? null
  }
}
