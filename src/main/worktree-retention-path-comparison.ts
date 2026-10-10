import { splitWorktreeId } from '../shared/worktree/id'
import { worktreePathComparisonKey } from './ipc/worktree-path-comparison'

/** Comparison keys used only to retain state; canonical equivalence must never select a delete target. */
export function worktreeRetentionPathComparisonKey(
  pathValue: string,
  platform: NodeJS.Platform
): string {
  return worktreePathComparisonKey(pathValue.normalize('NFC'), platform)
}

export function worktreeRetentionIdComparisonKey(
  worktreeId: string,
  platform: NodeJS.Platform
): string | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return null
  }
  return JSON.stringify([
    parsed.repoId,
    worktreeRetentionPathComparisonKey(parsed.worktreePath, platform)
  ])
}
