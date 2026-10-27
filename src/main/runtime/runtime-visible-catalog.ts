/** Client listings hide retained SSH/WSL source rows kept for downgrades; internal routing, selectors and migration use the full store. */
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../shared/worktree-execution-host-resolution'
import type { ProjectHostSetup } from '../../shared/project-types'
import {
  visibleFolderWorkspaces,
  visibleProjectGroups,
  visibleProjectHostSetups,
  visibleRepos
} from '../ssh/orcad-retained-source'
import type { RuntimeStore } from './runtime-store-contract'

type CatalogSource = Pick<
  RuntimeStore,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces' | 'getSshTargets' | 'getProjectHostSetups'
>

// Headless orcad has no SSH targets, so nothing of its own is ever a retained source.
function catalogStore(store: CatalogSource) {
  return {
    getRepos: () => store.getRepos(),
    getProjectGroups: () => store.getProjectGroups?.() ?? [],
    getFolderWorkspaces: () => store.getFolderWorkspaces?.() ?? [],
    getSshTargets: () => store.getSshTargets?.() ?? [],
    getProjectHostSetups: () => store.getProjectHostSetups?.() ?? []
  }
}

export function runtimeVisibleRepos(store: CatalogSource | null): Repo[] {
  return store ? visibleRepos(catalogStore(store)) : []
}

export function runtimeVisibleProjectGroups(store: CatalogSource | null): ProjectGroup[] {
  return store ? visibleProjectGroups(catalogStore(store)) : []
}

export function runtimeVisibleProjectHostSetups(store: CatalogSource | null): ProjectHostSetup[] {
  return store ? visibleProjectHostSetups(catalogStore(store)) : []
}

export function runtimeVisibleFolderWorkspaces(store: CatalogSource | null): FolderWorkspace[] {
  return store ? visibleFolderWorkspaces(catalogStore(store)) : []
}

export type RuntimeHiddenRepos = {
  readonly size: number
  hasRepo: (repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>) => boolean
  hasWorktree: (worktree: { repoId: string; hostId?: string | null }) => boolean
}

const NOTHING_HIDDEN: RuntimeHiddenRepos = {
  size: 0,
  hasRepo: () => false,
  hasWorktree: () => false
}

const repoRowKey = (repoId: string, hostId: ExecutionHostId): string => `${hostId}\0${repoId}`

/** Hidden repo rows are host-qualified: the same repo id may remain visible on another host. */
export function runtimeHiddenRepos(store: CatalogSource | null): RuntimeHiddenRepos {
  if (!store) {
    return NOTHING_HIDDEN
  }
  const all = store.getRepos()
  const visible = runtimeVisibleRepos(store)
  if (visible.length === all.length) {
    return NOTHING_HIDDEN
  }
  const keyOf = (repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>): string =>
    repoRowKey(repo.id, getRepoExecutionHostId(repo))
  const visibleKeys = new Set(visible.map(keyOf))
  const hiddenKeys = new Set(all.map(keyOf).filter((key) => !visibleKeys.has(key)))
  if (hiddenKeys.size === 0) {
    return NOTHING_HIDDEN
  }
  const lookup = createRepoRowExecutionHostLookup(all)
  const hasRepo = (repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>): boolean =>
    hiddenKeys.has(keyOf(repo))
  return {
    size: hiddenKeys.size,
    hasRepo,
    hasWorktree: (worktree) => {
      const resolution = resolveWorktreeExecutionHost(lookup, worktree)
      if (resolution.kind === 'resolved') {
        return hiddenKeys.has(repoRowKey(worktree.repoId, resolution.hostId))
      }
      // No single owning host: hidden only when every row carrying the id is.
      const rows = all.filter((repo) => repo.id === worktree.repoId)
      return rows.length > 0 && rows.every(hasRepo)
    }
  }
}

function folderHostId(folder: FolderWorkspace): ExecutionHostId | null {
  if (folder.executionHostId) {
    return folder.executionHostId
  }
  return folder.connectionId ? toSshExecutionHostId(folder.connectionId) : null
}

/** Exclude hosts known only through hidden rows from not-covered listings, or clients would be directed to intentionally hidden sources. */
export function runtimeHiddenHostIds(store: CatalogSource | null): ReadonlySet<ExecutionHostId> {
  const hiddenRepos = runtimeHiddenRepos(store)
  if (!store) {
    return new Set()
  }
  const folders = store.getFolderWorkspaces?.() ?? []
  const visibleFolders = runtimeVisibleFolderWorkspaces(store)
  if (hiddenRepos.size === 0 && visibleFolders.length === folders.length) {
    return new Set()
  }
  const visibleFolderIds = new Set(visibleFolders.map((folder) => folder.id))
  const hidden = new Set<ExecutionHostId>()
  const shown = new Set<ExecutionHostId>()
  const note = (hostId: ExecutionHostId | null, isHidden: boolean): void => {
    if (hostId && isHidden) {
      hidden.add(hostId)
    } else if (hostId) {
      shown.add(hostId)
    }
  }
  for (const repo of store.getRepos()) {
    note(getRepoExecutionHostId(repo), hiddenRepos.hasRepo(repo))
  }
  for (const folder of folders) {
    note(folderHostId(folder), !visibleFolderIds.has(folder.id))
  }
  // This machine always stays listed, even if a WSL move took every local project.
  return new Set(
    [...hidden].filter((hostId) => !shown.has(hostId) && hostId !== LOCAL_EXECUTION_HOST_ID)
  )
}

export function withoutHiddenHosts(
  hostIds: Iterable<ExecutionHostId>,
  hidden: ReadonlySet<ExecutionHostId>
): ExecutionHostId[] {
  return [...hostIds].filter((hostId) => !hidden.has(hostId))
}
