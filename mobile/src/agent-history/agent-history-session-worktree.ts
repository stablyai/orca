import { isPathInsideOrEqual, isRuntimePathAbsolute } from '../../../src/shared/cross-platform-path'
import { parseWslUncPath } from '../../../src/shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../src/shared/worktree/id'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

export type MobileAgentHistorySessionWorktreeStatus = 'current' | 'active' | 'archived'

export type MobileAgentHistorySessionWorktreeInfo = {
  status: MobileAgentHistorySessionWorktreeStatus
  worktreeId: string
  path: string
}

type WorktreeCandidate = {
  worktree: WorktreeWithPriorIds
  path: string
  source: 'current-path' | 'prior-path'
}

type WorktreeWithPriorIds = Worktree & {
  priorWorktreeIds?: readonly string[]
}

export function resolveMobileAgentHistorySessionWorktree(args: {
  session: Pick<AiVaultSession, 'cwd'>
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): MobileAgentHistorySessionWorktreeInfo | null {
  if (!args.session.cwd) {
    return null
  }
  const sessionCwd = args.session.cwd

  const candidates = buildMobileWorktreeCandidates(args.worktrees)
    .filter((candidate) => isSessionInWorktreePath(candidate.path, sessionCwd))
    .sort(compareWorktreeCandidates)
  const best = candidates[0]
  if (!best) {
    return null
  }

  return {
    status:
      best.worktree.worktreeId === args.activeWorktreeId
        ? 'current'
        : best.worktree.isArchived
          ? 'archived'
          : 'active',
    worktreeId: best.worktree.worktreeId,
    path: best.path
  }
}

/**
 * Worktree ids whose path matches the session cwd exactly as well as the preferred one, preferred
 * first, archived ones dropped. Several SSH workspaces on different hosts can share one path
 * (same repo checkout location), so the cwd alone cannot say which host holds a transcript.
 */
export function resolveMobileAgentHistorySessionWorktreeTies(args: {
  session: Pick<AiVaultSession, 'cwd'>
  worktrees: readonly Worktree[]
}): string[] {
  if (!args.session.cwd) {
    return []
  }
  const sessionCwd = args.session.cwd
  const candidates = buildMobileWorktreeCandidates(args.worktrees)
    .filter((candidate) => isSessionInWorktreePath(candidate.path, sessionCwd))
    .sort(compareWorktreeCandidates)
  const best = candidates[0]
  if (!best) {
    return []
  }
  const bestLength = normalizedPathLength(best.path)
  const ids: string[] = []
  for (const candidate of candidates) {
    if (normalizedPathLength(candidate.path) !== bestLength) {
      break
    }
    if (!candidate.worktree.isArchived && !ids.includes(candidate.worktree.worktreeId)) {
      ids.push(candidate.worktree.worktreeId)
    }
  }
  return ids
}

export function canResumeInMobileSessionWorktree(
  worktreeInfo: MobileAgentHistorySessionWorktreeInfo | null
): boolean {
  return Boolean(worktreeInfo && worktreeInfo.status !== 'archived')
}

function buildMobileWorktreeCandidates(worktrees: readonly Worktree[]): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
  for (const worktree of worktrees as readonly WorktreeWithPriorIds[]) {
    if (hasUsablePath(worktree.path)) {
      candidates.push({ worktree, path: worktree.path, source: 'current-path' })
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push({ worktree, path: parsed.worktreePath, source: 'prior-path' })
    }
  }
  return candidates
}

function hasUsablePath(pathValue: string): boolean {
  return Boolean(pathValue.trim() && isRuntimePathAbsolute(pathValue))
}

function isSessionInWorktreePath(worktreePath: string, sessionCwd: string): boolean {
  if (isPathInsideOrEqual(worktreePath, sessionCwd)) {
    return true
  }
  const wslPath = parseWslUncPath(worktreePath)
  return wslPath ? isPathInsideOrEqual(wslPath.linuxPath, sessionCwd) : false
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const lengthDifference = normalizedPathLength(right.path) - normalizedPathLength(left.path)
  if (lengthDifference !== 0) {
    return lengthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'current-path' ? -1 : 1
}

function normalizedPathLength(pathValue: string): number {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase().length
}
