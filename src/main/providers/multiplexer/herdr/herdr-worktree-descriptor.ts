import { normalize } from 'node:path'
import type { Worktree } from '../../../../shared/worktree/types'

export type HerdrWorktreeDescriptor = Pick<
  Worktree,
  'id' | 'instanceId' | 'path' | 'displayName'
> & {
  /** Git repo root (source) checkout; the stock `worktree.open` `--cwd`. */
  repoPath?: string
}

/** Linked git checkouts use worktree.open. The project root uses workspace.create. */
export function isLinkedHerdrWorktree(worktree: HerdrWorktreeDescriptor): boolean {
  if (!worktree.repoPath) {
    return false
  }
  return normalize(worktree.path) !== normalize(worktree.repoPath)
}
