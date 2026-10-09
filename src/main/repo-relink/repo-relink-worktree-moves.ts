import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { splitWorktreeId, WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'

export type WorktreeIdMove = { oldWorktreeId: string; newWorktreeId: string }

export type RepoRelinkWorktreeMoves = {
  moves: WorktreeIdMove[]
  /** Linked worktrees that moved with the repo but Git still lists at the old path. */
  staleLinkedWorktreeIds: string[]
}

/**
 * Map Orca's worktree ids for a relinked repo.
 *
 * The main worktree always follows the repo. A linked worktree moves only when it sat under the old
 * folder and `git worktree list` from the new folder reports it at the same relative path; Git keeps
 * stale paths for nested worktrees until `git worktree repair` runs, and re-keying to a path Git does
 * not list would strand the worktree's state on an id no scan produces.
 */
export function planRepoRelinkWorktreeMoves(args: {
  repoId: string
  oldPath: string
  newPath: string
  knownWorktreeIds: readonly string[]
  gitWorktrees: readonly GitWorktreeInfo[]
}): RepoRelinkWorktreeMoves {
  const oldKey = normalizeRuntimePathForComparison(args.oldPath)
  const newKey = normalizeRuntimePathForComparison(args.newPath)
  const newMainId = `${args.repoId}${WORKTREE_ID_SEPARATOR}${args.newPath}`
  const listedByKey = new Map<string, string>()
  for (const worktree of args.gitWorktrees) {
    if (!worktree.isMainWorktree) {
      listedByKey.set(normalizeRuntimePathForComparison(worktree.path), worktree.path)
    }
  }
  const knownKeys = new Set<string>()
  for (const worktreeId of args.knownWorktreeIds) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId === args.repoId) {
      knownKeys.add(normalizeRuntimePathForComparison(parsed.worktreePath))
    }
  }
  const moves: WorktreeIdMove[] = []
  const staleLinkedWorktreeIds: string[] = []
  const seen = new Set<string>()
  // Two spellings moving onto one id would make the second migration overwrite the first.
  const claimedTargets = new Set<string>()
  const pushMove = (oldWorktreeId: string, newWorktreeId: string): void => {
    if (oldWorktreeId !== newWorktreeId && !claimedTargets.has(newWorktreeId)) {
      claimedTargets.add(newWorktreeId)
      moves.push({ oldWorktreeId, newWorktreeId })
    }
  }
  const candidates = [
    `${args.repoId}${WORKTREE_ID_SEPARATOR}${args.oldPath}`,
    ...args.knownWorktreeIds
  ]
  for (const worktreeId of candidates) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId !== args.repoId || seen.has(worktreeId)) {
      continue
    }
    seen.add(worktreeId)
    const pathKey = normalizeRuntimePathForComparison(parsed.worktreePath)
    if (pathKey === oldKey) {
      pushMove(worktreeId, newMainId)
      continue
    }
    if (!pathKey.startsWith(`${oldKey}/`)) {
      continue
    }
    const listedPath = listedByKey.get(`${newKey}${pathKey.slice(oldKey.length)}`)
    if (!listedPath) {
      staleLinkedWorktreeIds.push(worktreeId)
      continue
    }
    // A destination Orca already tracks keeps its own state; merging would lose one of them.
    if (knownKeys.has(normalizeRuntimePathForComparison(listedPath))) {
      continue
    }
    pushMove(worktreeId, `${args.repoId}${WORKTREE_ID_SEPARATOR}${listedPath}`)
  }
  return { moves, staleLinkedWorktreeIds }
}
