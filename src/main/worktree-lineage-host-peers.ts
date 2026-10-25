import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../shared/resolved-worktree-lineage'
import { readAllWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'
import type { RuntimeStore } from './runtime/runtime-store-contract'

type HostPeerStore = Pick<
  RuntimeStore,
  'getRepos' | 'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost' | 'getAllWorktreeLineage'
>

export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[]
) {
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  if (rows.length === 0) {
    return projectResolvedWorktreeLineage(rows, lineageById)
  }
  const relatedIds = getConnectedWorktreeLineageIds(
    rows.map((row) => row.id),
    lineageById
  )
  const ownIds = new Set(rows.map((row) => row.id))
  if ([...relatedIds].every((id) => ownIds.has(id) || getRepoIdFromWorktreeId(id) === repo.id)) {
    return projectResolvedWorktreeLineage(rows, lineageById)
  }
  const hostId = getRepoExecutionHostId(repo)
  const repos = store.getRepos()
  const reposById = new Map<string, Repo[]>()
  for (const candidate of repos) {
    const owners = reposById.get(candidate.id) ?? []
    owners.push(candidate)
    reposById.set(candidate.id, owners)
  }
  const metaById = readAllWorktreeMetaForHost(store, hostId)
  const peers: Worktree[] = []
  for (const id of relatedIds) {
    if (ownIds.has(id) || getRepoIdFromWorktreeId(id) === repo.id) {
      continue
    }
    const owners = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    const evidence = owners.map(resolveRepoOwnershipEvidence)
    const hostOwners = owners.filter((_, index) => {
      const owner = evidence[index]
      return owner?.status === 'owned' && owner.hostId === hostId
    })
    const meta = metaById[id]
    if (
      evidence.some((owner) => owner.status !== 'owned') ||
      hostOwners.length !== 1 ||
      !meta ||
      (!meta.instanceId && !isFolderRepo(hostOwners[0])) ||
      (!meta.hostId && owners.length > 1)
    ) {
      continue
    }
    const owner = hostOwners[0]
    if (isFolderRepo(owner)) {
      if (isFolderWorkspaceIdForRepo(owner, id)) {
        const peerMeta =
          meta.instanceId || id === getFolderWorkspaceRootId(owner)
            ? meta
            : { ...meta, instanceId: getFolderWorkspaceInstanceIdentity(owner, id) }
        peers.push(mergeFolderWorkspace(owner, id, peerMeta))
      }
      continue
    }
    const parsed = splitWorktreeId(id)
    if (!parsed?.worktreePath) {
      continue
    }
    peers.push(
      mergeWorktree(
        owner.id,
        {
          path: parsed.worktreePath,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: areWorktreePathsEqual(parsed.worktreePath, owner.path)
        },
        meta,
        owner.displayName
      )
    )
  }
  return projectResolvedWorktreeLineage(rows, lineageById, peers)
}
