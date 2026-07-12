import type { GitCapabilityCache } from '../shared/git-capability-cache'
import type { GitExec } from './git-handler-ops'
import { isUnsupportedWorktreeListZError, parseWorktreeList } from './git-handler-utils'

export type RelayWorktreeInfo = {
  path: string
  branch?: string
  head?: string
  locked?: boolean
  lockReason?: string
}

export async function readRelayWorktreeList(
  git: GitExec,
  repoPath: string,
  capabilities: GitCapabilityCache
): Promise<RelayWorktreeInfo[]> {
  return capabilities.runWithFallback(
    'worktree-list-z',
    async () => {
      const { stdout } = await git(['worktree', 'list', '--porcelain', '-z'], repoPath)
      return normalizeRelayWorktrees(parseWorktreeList(stdout, { nulDelimited: true }))
    },
    async () => {
      // Why: `-z` preserves newlines; fallback keeps Git <2.36 compatible.
      const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
      return normalizeRelayWorktrees(parseWorktreeList(stdout))
    },
    isUnsupportedWorktreeListZError
  )
}

function normalizeRelayWorktrees(worktrees: Record<string, unknown>[]): RelayWorktreeInfo[] {
  return worktrees
    .map((worktree) => ({
      path: typeof worktree.path === 'string' ? worktree.path : '',
      head: typeof worktree.head === 'string' ? worktree.head : undefined,
      branch: typeof worktree.branch === 'string' ? worktree.branch : undefined,
      locked: worktree.locked === true ? true : undefined,
      lockReason: typeof worktree.lockReason === 'string' ? worktree.lockReason : undefined
    }))
    .filter((worktree) => worktree.path.length > 0)
}
