import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { worktreePathComparisonKey } from '../ipc/worktree-path-comparison'

type ResolvedWorktreePath = { id: string; repoId: string; path: string }
type RuntimeWorktreeSummaryPathCandidate = { summary: RuntimeWorktreePsSummary; order: number }

export type RuntimeWorktreeSummaryPathIndex = {
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
  posixAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidate>
  posixRelative: Map<string, RuntimeWorktreeSummaryPathCandidate>
  windows: Map<string, RuntimeWorktreeSummaryPathCandidate>
  windowsAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidate>
}

export function buildRuntimeWorktreeSummaryPathIndex(
  summaries: ReadonlyMap<string, RuntimeWorktreePsSummary>,
  resolvedWorktrees: readonly ResolvedWorktreePath[],
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
): RuntimeWorktreeSummaryPathIndex {
  const index: RuntimeWorktreeSummaryPathIndex = {
    platformByRepoId,
    posixAbsolute: new Map(),
    posixRelative: new Map(),
    windows: new Map(),
    windowsAbsolute: new Map()
  }
  for (const [order, worktree] of resolvedWorktrees.entries()) {
    const summary = summaries.get(worktree.id)
    if (!summary) {
      continue
    }
    const platform = platformByRepoId.get(worktree.repoId) ?? process.platform
    const candidate = { summary, order }
    if (isPosixAbsoluteRuntimeWorktreePath(worktree.path)) {
      setFirstRuntimeWorktreePathCandidate(
        index.posixAbsolute,
        runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, platform),
        candidate
      )
      continue
    }
    const windowsKey = runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, 'win32')
    setFirstRuntimeWorktreePathCandidate(index.windows, windowsKey, candidate)
    if (isWindowsAbsolutePathLike(worktree.path)) {
      setFirstRuntimeWorktreePathCandidate(index.windowsAbsolute, windowsKey, candidate)
    } else if (platform !== 'win32') {
      setFirstRuntimeWorktreePathCandidate(
        index.posixRelative,
        runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, platform),
        candidate
      )
    }
  }
  return index
}

export function findRuntimeWorktreeSummaryByPath(
  index: RuntimeWorktreeSummaryPathIndex,
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform
): RuntimeWorktreePsSummary | null {
  if (isPosixAbsoluteRuntimeWorktreePath(worktreePath)) {
    return (
      index.posixAbsolute.get(runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform))
        ?.summary ?? null
    )
  }
  const windowsKey = runtimeWorktreeSummaryPathKey(repoId, worktreePath, 'win32')
  if (platform === 'win32' || isWindowsAbsolutePathLike(worktreePath)) {
    return index.windows.get(windowsKey)?.summary ?? null
  }
  const posixCandidate = index.posixRelative.get(
    runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform)
  )
  const windowsCandidate = index.windowsAbsolute.get(windowsKey)
  // Why: a malformed path can match both the POSIX and Windows indexes; keep the old pairwise scan's first-match order.
  if (!posixCandidate) {
    return windowsCandidate?.summary ?? null
  }
  if (!windowsCandidate || posixCandidate.order < windowsCandidate.order) {
    return posixCandidate.summary
  }
  return windowsCandidate.summary
}

function setFirstRuntimeWorktreePathCandidate(
  candidates: Map<string, RuntimeWorktreeSummaryPathCandidate>,
  key: string,
  candidate: RuntimeWorktreeSummaryPathCandidate
): void {
  if (!candidates.has(key)) {
    candidates.set(key, candidate)
  }
}

function isPosixAbsoluteRuntimeWorktreePath(worktreePath: string): boolean {
  return worktreePath.startsWith('/') && !worktreePath.startsWith('//')
}

function runtimeWorktreeSummaryPathKey(
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform
): string {
  return `${repoId}\0${worktreePathComparisonKey(worktreePath, platform)}`
}
