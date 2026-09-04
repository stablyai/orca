import { isRuntimePathAbsolute } from '../../../src/shared/cross-platform-path'
import {
  createWslAliasedPathInsideOrEqualMatcher,
  normalizedWslPathCandidateAliases,
  wslAliasedPathDepth
} from '../../../src/shared/wsl-path-aliases'
import {
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
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
  hostId: ExecutionHostId
  pathDepth: number
  ownsNormalizedCwd: (normalizedCwd: string) => boolean
  source: 'current-path' | 'prior-path'
}

type WorktreeRepoHost = {
  id: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

type WorktreeWithPriorIds = Worktree & {
  priorWorktreeIds?: readonly string[]
}

export function resolveMobileAgentHistorySessionWorktree(args: {
  session: Pick<AiVaultSession, 'cwd' | 'executionHostId'>
  worktrees: readonly Worktree[]
  repos?: readonly WorktreeRepoHost[]
  activeWorktreeId: string | null
}): MobileAgentHistorySessionWorktreeInfo | null {
  if (!args.session.cwd) {
    return null
  }
  const sessionHostId = normalizeExecutionHostId(args.session.executionHostId)
  const cwdAliases = normalizedWslPathCandidateAliases(args.session.cwd)
  const best = findBestMobileWorktreeCandidate(
    buildMobileWorktreeCandidates(args.worktrees, args.repos ?? []),
    sessionHostId,
    cwdAliases
  )
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

function findBestMobileWorktreeCandidate(
  candidates: readonly WorktreeCandidate[],
  sessionHostId: AiVaultSession['executionHostId'] | null,
  normalizedCwdAliases: readonly string[]
): WorktreeCandidate | null {
  let best: WorktreeCandidate | null = null
  for (const candidate of candidates) {
    if (sessionHostId && candidate.hostId !== sessionHostId) {
      continue
    }
    if (!normalizedCwdAliases.some(candidate.ownsNormalizedCwd)) {
      continue
    }
    if (!best || compareWorktreeCandidates(candidate, best) < 0) {
      best = candidate
    }
  }
  return best
}

export function canResumeInMobileSessionWorktree(
  worktreeInfo: MobileAgentHistorySessionWorktreeInfo | null
): boolean {
  return Boolean(worktreeInfo && worktreeInfo.status !== 'archived')
}

function buildMobileWorktreeCandidates(
  worktrees: readonly Worktree[],
  repos: readonly WorktreeRepoHost[]
): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const worktree of worktrees as readonly WorktreeWithPriorIds[]) {
    const repo = repoById.get(worktree.repoId)
    const hostId = getWorktreeExecutionHostId(
      worktree,
      repo
        ? {
            connectionId: repo.connectionId ?? null,
            executionHostId: repo.executionHostId ?? null
          }
        : undefined
    )
    if (hasUsablePath(worktree.path)) {
      candidates.push({
        worktree,
        path: worktree.path,
        hostId,
        pathDepth: wslAliasedPathDepth(worktree.path),
        ownsNormalizedCwd: createWslAliasedPathInsideOrEqualMatcher(worktree.path),
        source: 'current-path'
      })
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push({
        worktree,
        path: parsed.worktreePath,
        hostId,
        pathDepth: wslAliasedPathDepth(parsed.worktreePath),
        ownsNormalizedCwd: createWslAliasedPathInsideOrEqualMatcher(parsed.worktreePath),
        source: 'prior-path'
      })
    }
  }
  return candidates
}

function hasUsablePath(pathValue: string): boolean {
  return Boolean(pathValue.trim() && isRuntimePathAbsolute(pathValue))
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const depthDifference = right.pathDepth - left.pathDepth
  if (depthDifference !== 0) {
    return depthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'current-path' ? -1 : 1
}
