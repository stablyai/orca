import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { Repo } from '../../../../shared/repo-types'
import {
  createRepoRowExecutionHostLookup,
  type RepoRowExecutionHostLookup
} from '../../../../shared/execution-host/worktree-execution-host-resolution'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import { parsePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import {
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey,
  worktreeIdsEqual
} from '../../../../shared/worktree/id'
import { normalizeLocalBranchName } from './runtime-worktree-selection'

export type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export function branchSelectorMatches(branch: string, selector: string): boolean {
  // Git plumbing may report local branches with or without refs/heads/.
  return normalizeLocalBranchName(branch) === normalizeLocalBranchName(selector)
}

export function runtimePathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

export function createIncrementalResolvedWorktreeLookup(
  resolvedWorktrees: ResolvedWorktree[]
): (worktreeId: string) => ResolvedWorktree | undefined {
  const worktreeByIdentity = new Map<string, ResolvedWorktree>()
  let indexedCount = 0
  return (worktreeId) => {
    const lookupKey = worktreeIdentityKey(worktreeId)
    const indexed = worktreeByIdentity.get(lookupKey)
    if (indexed) {
      return indexed
    }
    while (indexedCount < resolvedWorktrees.length) {
      const worktree = resolvedWorktrees[indexedCount]
      indexedCount += 1
      const key = worktreeIdentityKey(worktree.id)
      // Preserve Array.find's first match when normalized identities collide.
      if (!worktreeByIdentity.has(key)) {
        worktreeByIdentity.set(key, worktree)
      }
      if (key === lookupKey) {
        return worktreeByIdentity.get(key)
      }
    }
    return undefined
  }
}

export function resolveTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  targetWorktreeId: string
): string | null {
  const keyedWorktreeIds = new Set([
    ...Object.keys(session.tabsByWorktree),
    ...Object.keys(session.tabGroups ?? {}),
    ...Object.keys(session.tabGroupLayouts ?? {}),
    ...Object.keys(session.activeTabIdByWorktree ?? {}),
    ...Object.keys(session.activeGroupIdByWorktree ?? {})
  ])
  const matches = [...keyedWorktreeIds].filter((worktreeId) =>
    worktreeIdsEqual(worktreeId, targetWorktreeId)
  )
  return matches.length > 1 ? null : (matches[0] ?? targetWorktreeId)
}

export function inferWorktreeIdFromPtyId(ptyId: string): string | null {
  return parsePtySessionId(ptyId).worktreeId
}

export function parseRuntimeWorktreeId(
  worktreeId: string
): { repoId: string; worktreePath: string } | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId) {
    return null
  }
  if (!parsed.worktreePath) {
    return null
  }
  return parsed
}

export function includeTargetResolvedWorktree(
  resolvedWorktrees: ResolvedWorktree[],
  targetWorktree: ResolvedWorktree | null
): ResolvedWorktree[] {
  if (!targetWorktree || resolvedWorktrees.some((worktree) => worktree.id === targetWorktree.id)) {
    return resolvedWorktrees
  }
  return [...resolvedWorktrees, targetWorktree]
}

export function findResolvedWorktreeIdForPath(
  resolvedWorktrees: ResolvedWorktree[],
  cwd: string,
  targetWorktreeId?: string | null
): string | null {
  if (!cwd) {
    return null
  }
  const matches = resolvedWorktrees
    .filter((worktree) => isPathInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)
  // Folder siblings share cwd: prefer the caller's target only among deepest-path ties, never over a nested worktree.
  const deepest = matches.filter((worktree) => worktree.path.length === matches[0]?.path.length)
  return (
    (deepest.length > 1
      ? deepest.find((worktree) => worktree.id === targetWorktreeId)?.id
      : undefined) ??
    matches[0]?.id ??
    null
  )
}

export function listKnownResolvedWorktreesForExplicitTarget(
  store: Pick<RuntimeStore, 'getAllWorktreeMeta' | 'getRepos'> | null,
  buildResolvedWorktreeFromId: (
    worktreeId: string,
    repos: RepoRowExecutionHostLookup<Repo>
  ) => ResolvedWorktree | null,
  targetWorktreeId: string,
  targetWorktree: ResolvedWorktree | null
): ResolvedWorktree[] {
  if (!store || !targetWorktree) {
    return []
  }
  const target = splitWorktreeIdForFilesystem(targetWorktreeId)
  if (!target?.repoId || !target.worktreePath) {
    // Folder workspace keys have no repo/path tuple, but the converted row
    // is already authoritative for this explicit target.
    return [targetWorktree]
  }
  const worktreeIds = new Set(
    Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) => {
      const parsed = splitWorktreeIdForFilesystem(worktreeId)
      return (
        parsed?.repoId === target.repoId &&
        Boolean(parsed.worktreePath) &&
        (isPathInsideOrEqual(target.worktreePath, parsed.worktreePath) ||
          isPathInsideOrEqual(parsed.worktreePath, target.worktreePath))
      )
    })
  )
  worktreeIds.add(targetWorktreeId)

  const resolved: ResolvedWorktree[] = []
  const repos = createRepoRowExecutionHostLookup(store.getRepos())
  for (const worktreeId of worktreeIds) {
    const worktree =
      worktreeId === targetWorktreeId
        ? targetWorktree
        : buildResolvedWorktreeFromId(worktreeId, repos)
    if (worktree) {
      resolved.push(worktree)
    }
  }
  return resolved
}
