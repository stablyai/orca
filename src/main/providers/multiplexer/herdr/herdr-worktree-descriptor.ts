import type { Worktree } from '../../../../shared/worktree/types'

export type HerdrWorktreeDescriptor = Pick<
  Worktree,
  'id' | 'instanceId' | 'path' | 'displayName'
> & {
  /** Git repo root (source) checkout; the stock `worktree.open` `--cwd`. */
  repoPath?: string
}
