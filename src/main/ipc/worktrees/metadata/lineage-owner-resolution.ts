import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorktreeId } from '../../worktree-logic'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { resolveRepoOwnershipEvidence } from '../listing/worktree-host-ownership'

export type LineageOwner =
  | { status: 'owned'; hostId: ExecutionHostId }
  | { status: 'ambiguous' | 'contradictory' | 'runtime' }

export type LineageFolder = FolderWorkspace
export type LineageGroup = ProjectGroup

export type LineageResolutionContext = {
  store: Store
  repos: Repo[]
  groups: LineageGroup[]
  reposById: Map<string, Repo[]>
  foldersById: Map<string, LineageFolder[]>
  groupsById: Map<string, LineageGroup[]>
  groupSubtreeIdsByRoot: Map<string, Set<string>>
  worktreeOwners: Map<string, LineageOwner>
  folderOwners: Map<string, LineageOwner>
  workspaceOwners: Map<string, LineageOwner>
}

export function indexLineageEntriesById<T extends { id: string }>(
  entries: readonly T[]
): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const entry of entries) {
    const matching = index.get(entry.id) ?? []
    matching.push(entry)
    index.set(entry.id, matching)
  }
  return index
}

export function createLineageResolutionContext(store: Store): LineageResolutionContext {
  const repos = store.getRepos()
  const folders = store.getFolderWorkspaces()
  const groups = store.getProjectGroups()
  return {
    store,
    repos,
    groups,
    reposById: indexLineageEntriesById(repos),
    foldersById: indexLineageEntriesById(folders),
    groupsById: indexLineageEntriesById(groups),
    groupSubtreeIdsByRoot: new Map(),
    worktreeOwners: new Map(),
    folderOwners: new Map(),
    workspaceOwners: new Map()
  }
}

export function resolveRepoLineageOwner(repo: Repo): LineageOwner {
  const owner = resolveRepoOwnershipEvidence(repo)
  if (owner.status === 'malformed') {
    return { status: 'ambiguous' }
  }
  if (owner.status === 'contradictory') {
    return { status: 'contradictory' }
  }
  return parseExecutionHostId(owner.hostId)?.kind === 'runtime' ? { status: 'runtime' } : owner
}

export function resolveWorktreeLineageOwner(
  context: LineageResolutionContext,
  worktreeId: string
): LineageOwner {
  const cached = context.worktreeOwners.get(worktreeId)
  if (cached) {
    return cached
  }
  const remember = (owner: LineageOwner): LineageOwner => {
    context.worktreeOwners.set(worktreeId, owner)
    return owner
  }
  let repoId: string
  try {
    repoId = parseWorktreeId(worktreeId).repoId
  } catch {
    return remember({ status: 'ambiguous' })
  }
  const repos = context.reposById.get(repoId) ?? []
  const meta = context.store.getWorktreeMeta(worktreeId)
  const runtimeOwnerEnvironmentId = (
    meta as (WorktreeMeta & { runtimeOwnerEnvironmentId?: string }) | undefined
  )?.runtimeOwnerEnvironmentId?.trim()
  if (runtimeOwnerEnvironmentId) {
    return remember({ status: 'runtime' })
  }
  if (meta?.hostId) {
    const explicitHost = parseExecutionHostId(meta.hostId)
    if (!explicitHost) {
      return remember({ status: 'ambiguous' })
    }
    if (explicitHost.kind === 'runtime') {
      return remember({ status: 'runtime' })
    }
    const matchingRepos = repos.filter((repo) => {
      const owner = resolveRepoLineageOwner(repo)
      return owner.status === 'owned' && owner.hostId === explicitHost.id
    })
    if (matchingRepos.length === 1) {
      return remember({ status: 'owned', hostId: explicitHost.id })
    }
    return remember(
      matchingRepos.length > 1
        ? { status: 'ambiguous' }
        : { status: repos.length > 0 ? 'contradictory' : 'ambiguous' }
    )
  }
  if (repos.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  return remember(resolveRepoLineageOwner(repos[0]))
}
