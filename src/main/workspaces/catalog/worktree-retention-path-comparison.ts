import { splitWorktreeId } from '../../../shared/worktree/id'
import { worktreePathComparisonKey } from './worktree-path-comparison-key'

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) {
      return false
    }
  }
  return true
}

/** Comparison keys used only to retain state; canonical equivalence must never select a delete target. */
export function worktreeRetentionPathComparisonKey(
  pathValue: string,
  platform: NodeJS.Platform
): string {
  return worktreePathComparisonKey(
    isAscii(pathValue) ? pathValue : pathValue.normalize('NFC'),
    platform
  )
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
