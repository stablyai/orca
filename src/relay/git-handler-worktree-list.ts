import { stat } from 'node:fs/promises'
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

const PRUNABLE_EXISTENCE_PROBE_CONCURRENCY = 8

/** Why: Git <2.31 does not emit the `prunable` porcelain annotation, so probe
 *  each linked worktree path directly instead of treating a stale registration
 *  as a live workspace (issue #8389). Runs on the `-z`-unsupported fallback
 *  (Git <2.36); on Git 2.31–2.35 the annotation is already parsed, so this is a
 *  harmless backstop. The relay owns the filesystem, so a plain stat is
 *  authoritative. */
export async function annotatePrunableWorktreesByExistence(
  worktrees: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function probeNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      const worktreePath = typeof worktree?.path === 'string' ? worktree.path : ''
      // Git only marks linked worktrees prunable, and never locked ones (a
      // lock shields the registration even when the directory is missing). The
      // `locked` annotation is only parsed on Git >=2.31, so on older Git a
      // locked+missing worktree cannot be shielded here. A missing main
      // worktree is surfaced by the repo-level failure paths.
      if (
        !worktreePath ||
        worktree.isMainWorktree === true ||
        worktree.isBare === true ||
        worktree.locked === true ||
        worktree.prunable === true
      ) {
        continue
      }
      try {
        await stat(worktreePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          annotated[index] = { ...worktree, prunable: true }
        }
      }
    }
  }

  const workerCount = Math.min(PRUNABLE_EXISTENCE_PROBE_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  return annotated
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
