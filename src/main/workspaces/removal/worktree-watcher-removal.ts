import type { WatcherRemovalDeadline } from './watcher-removal-drain'

/** Coordinate renderer watcher removal; renderer-free hosts have no watches, so the default is inert. */
export type WorktreeWatcherRemoval = {
  closeLocal(worktreePath: string, deadline?: WatcherRemovalDeadline): Promise<void>
  restoreLocal(worktreePath: string): Promise<void>
  forgetLocal(worktreePath: string): void
}

const inert: WorktreeWatcherRemoval = {
  closeLocal: async () => {},
  restoreLocal: async () => {},
  forgetLocal: () => {}
}

let current: WorktreeWatcherRemoval = inert

export function setWorktreeWatcherRemoval(next: WorktreeWatcherRemoval | null): void {
  current = next ?? inert
}

export function getWorktreeWatcherRemoval(): WorktreeWatcherRemoval {
  return current
}
