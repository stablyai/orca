// Merges the workspace catalogs of every paired desktop into one list, the way
// the desktop sidebar merges the workspaces of every execution host it owns.
//
// Two paired desktops are independent Orca installs, so nothing about their ids
// is globally unique. Row identity is therefore rewritten here, once, before any
// list code sees it; execution-host identity is resolved here too so the shared
// filter/group/sort pipeline stays unaware that more than one desktop exists.

import {
  LOCAL_EXECUTION_HOST_ID,
  getExecutionHostLabel,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { RepoSummary } from './host-worktree-rpc-types'
import type { Worktree } from './workspace-list-types'

/** One paired desktop's catalog, as already read by the Home screen. */
export type DesktopWorkspaceCatalog = {
  desktopHostId: string
  desktopHostName: string
  worktrees: readonly Worktree[]
  repos?: readonly RepoSummary[]
}

export type MergedWorkspace = Worktree & {
  /** Paired desktop this row came from - the RPC target for opening it. */
  desktopHostId: string
  desktopHostName: string
  /** Id on its own desktop, before this module namespaced it. */
  desktopWorktreeId: string
}

function tupleId(kind: 'repo' | 'worktree', desktopHostId: string, localId: string): string {
  return JSON.stringify([kind, desktopHostId, localId])
}

export function getMergedDesktopRepoId(desktopHostId: string, repoId: string): string {
  return tupleId('repo', desktopHostId, repoId)
}

function getMergedDesktopWorktreeId(desktopHostId: string, worktreeId: string): string {
  return tupleId('worktree', desktopHostId, worktreeId)
}

function resolveExecutionHostId(
  worktree: Worktree,
  reposById: ReadonlyMap<string, RepoSummary>
): ExecutionHostId | null {
  if (worktree.hostId !== undefined) {
    return normalizeExecutionHostId(worktree.hostId)
  }
  const repo = reposById.get(worktree.repoId)
  // Why mirror getWorktreeExecutionHostId's precedence: a repo pinned to an SSH
  // connection owns every workspace under it, even ones whose payload predates
  // hostId. Falling straight to local would file those under the wrong host.
  if (!repo) {
    return null
  }
  return getRepoExecutionHostId({
    connectionId: repo.connectionId ?? null,
    executionHostId: repo.executionHostId ?? null
  })
}

function filterIdentity(
  catalog: DesktopWorkspaceCatalog,
  executionHostId: ExecutionHostId | null
): { id: string; label: string } {
  const hostLabel = executionHostId ? getExecutionHostLabel(executionHostId) : 'Unknown host'
  return {
    id: JSON.stringify([catalog.desktopHostId, executionHostId]),
    label: `${catalog.desktopHostName} · ${hostLabel}`
  }
}

/**
 * Flattens every desktop's catalog into one list whose row ids are unique across
 * desktops. Lineage keeps working because parent links are rewritten with the
 * same namespace, so a parent is only ever found on its own desktop.
 */
export function mergeDesktopWorkspaces(
  catalogs: readonly DesktopWorkspaceCatalog[]
): MergedWorkspace[] {
  const merged: MergedWorkspace[] = []
  for (const catalog of catalogs) {
    const reposById = new Map((catalog.repos ?? []).map((repo) => [repo.id, repo]))
    for (const worktree of catalog.worktrees) {
      const executionHostId = resolveExecutionHostId(worktree, reposById)
      const executionHostFilter = filterIdentity(catalog, executionHostId)
      merged.push({
        ...worktree,
        worktreeId: getMergedDesktopWorktreeId(catalog.desktopHostId, worktree.worktreeId),
        repoId: getMergedDesktopRepoId(catalog.desktopHostId, worktree.repoId),
        parentWorktreeId: worktree.parentWorktreeId
          ? getMergedDesktopWorktreeId(catalog.desktopHostId, worktree.parentWorktreeId)
          : (worktree.parentWorktreeId ?? null),
        ...(worktree.childWorktreeIds
          ? {
              childWorktreeIds: worktree.childWorktreeIds.map((id) =>
                getMergedDesktopWorktreeId(catalog.desktopHostId, id)
              )
            }
          : {}),
        hostId: executionHostId ?? undefined,
        executionHostFilterId: executionHostFilter.id,
        executionHostFilterLabel: executionHostFilter.label,
        desktopHostId: catalog.desktopHostId,
        desktopHostName: catalog.desktopHostName,
        desktopWorktreeId: worktree.worktreeId
      })
    }
  }
  return merged
}

export type ExecutionHostFilterOption = {
  id: string
  label: string
  count: number
}

/**
 * The execution hosts represented in a merged list, most-populated first, for
 * the filter drawer. Only hosts that actually own a row are offered, so the
 * drawer can never present a filter that empties the list.
 */
export function executionHostFilterOptions(
  worktrees: readonly Worktree[]
): ExecutionHostFilterOption[] {
  const options = new Map<string, ExecutionHostFilterOption>()
  for (const worktree of worktrees) {
    const id = worktree.executionHostFilterId ?? worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
    const current = options.get(id)
    options.set(id, {
      id,
      label:
        worktree.executionHostFilterLabel ??
        getExecutionHostLabel(worktree.hostId ?? LOCAL_EXECUTION_HOST_ID),
      count: (current?.count ?? 0) + 1
    })
  }
  return [...options.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Drops selections that no longer match any row so a stale filter cannot hide everything. */
export function retainRepresentedExecutionHostIds(
  selected: ReadonlySet<string>,
  options: readonly ExecutionHostFilterOption[]
): Set<string> {
  const represented = new Set(options.map((option) => option.id))
  return new Set([...selected].filter((id) => represented.has(id)))
}
