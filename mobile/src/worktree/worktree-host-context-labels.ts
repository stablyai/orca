import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import {
  getHostContextLabel,
  getMixedHostContextLabels as getSharedMixedHostContextLabels
} from '../../../src/shared/worktree/host-context-labels'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
export {
  buildHostLabelById,
  getHostContextLabel
} from '../../../src/shared/worktree/host-context-labels'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import type { Worktree } from './workspace-list-types'
import { getHostHealthBadgeLabel } from './worktree-host-health'

export type HostLabelSources = {
  /** Host id per repo id from repo.list; rows from hosts that predate `hostId` fall back to it. */
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  /** User-facing labels for non-local hosts: SSH target labels, then per-host display overrides. */
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
  /** The paired host's own platform; the phone's platform must never name the desktop. */
  hostPlatform: NodeJS.Platform | null
  /** Health per host the desktop reports one for; an absent host keeps the bare label. */
  hostHealthById: ReadonlyMap<ExecutionHostId, ExecutionHostHealth>
}

export function buildRepoHostIdByRepoId(
  repos: readonly { id: string; connectionId?: string | null; executionHostId?: string | null }[]
): Map<string, ExecutionHostId> {
  return new Map(repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)]))
}

export function resolveWorktreeHostId(
  worktree: Pick<Worktree, 'hostId' | 'repoId'>,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): ExecutionHostId {
  return (
    normalizeExecutionHostId(worktree.hostId) ??
    repoHostIdByRepoId.get(worktree.repoId) ??
    LOCAL_EXECUTION_HOST_ID
  )
}

function getResolvedWorktreeRowIdentity(
  worktree: Pick<Worktree, 'worktreeId' | 'hostId' | 'repoId'>,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): string {
  return composeWorktreeHostIdentity(
    resolveWorktreeHostId(worktree, repoHostIdByRepoId),
    worktree.worktreeId
  )
}

// Kept as a local adapter so existing mobile imports remain stable.

/**
 * Host label per row identity, only when the list spans more than one host — a single-host
 * list gains nothing from a badge on every row. Mirrors the desktop sidebar's mixed-host rule.
 */
export function getWorktreeHostContextLabels(
  worktrees: readonly Worktree[],
  sources: HostLabelSources
): Map<string, string> | undefined {
  return getSharedMixedHostContextLabels(worktrees, {
    getHostId: (worktree) => resolveWorktreeHostId(worktree, sources.repoHostIdByRepoId),
    // Legacy hosts omit row.hostId; key by the resolved repo owner so duplicate
    // worktree ids from different hosts do not overwrite each other's label.
    getIdentity: (worktree) => getResolvedWorktreeRowIdentity(worktree, sources.repoHostIdByRepoId),
    sources
  })
}

export function applyWorktreeHostContextLabels(
  worktrees: Worktree[],
  sources: HostLabelSources
): Worktree[] {
  const labels = getWorktreeHostContextLabels(worktrees, sources)
  // Why: the desktop card shows SSH status on any host count, so an unhealthy host is named even alone.
  const anyUnhealthy = [...sources.hostHealthById.values()].some(getHostHealthBadgeLabel)
  if (!labels && !anyUnhealthy) {
    return worktrees
  }
  return worktrees.map((worktree) => {
    const hostContextHostId = resolveWorktreeHostId(worktree, sources.repoHostIdByRepoId)
    const hostContextHealthLabel = getHostHealthBadgeLabel(
      sources.hostHealthById.get(hostContextHostId)
    )
    const hostContextLabel = labels
      ? labels.get(getResolvedWorktreeRowIdentity(worktree, sources.repoHostIdByRepoId))
      : hostContextHealthLabel && getHostContextLabel(hostContextHostId, sources)
    if (!hostContextLabel) {
      return worktree
    }
    return {
      ...worktree,
      hostContextLabel,
      hostContextHostId,
      ...(hostContextHealthLabel ? { hostContextHealthLabel } : {})
    }
  })
}
