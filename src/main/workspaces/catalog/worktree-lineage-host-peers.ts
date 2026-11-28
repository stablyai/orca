import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../shared/worktree/id'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../../../shared/worktree/lineage/resolved-worktree-lineage'
import { readAllWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { mergeWorktree } from '../../ipc/worktrees/metadata/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from '../../ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from '../../ipc/worktrees/folder-workspace-model'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { withInlineFolderLineage } from './inline-folder-lineage'

type HostPeerStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getAllWorkspaceLineage'
>

/** A listing's rows with their worktree lineage projected and their own folder parents attached. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[]
) {
  return withInlineFolderLineage(store, projectWorktreeLineage(store, repo, rows))
}

function hasOwnKeys(record: Readonly<Record<string, unknown>>): boolean {
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      return true
    }
  }
  return false
}

function projectWorktreeLineage<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[]
) {
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  if (rows.length === 0 || !hasOwnKeys(lineageById)) {
    return projectResolvedWorktreeLineage(rows, lineageById)
  }
  const seedIds: string[] = []
  const ownIds = new Set<string>()
  for (const row of rows) {
    seedIds.push(row.id)
    ownIds.add(row.id)
  }
  const relatedIds = getConnectedWorktreeLineageIds(seedIds, lineageById)
  let hasExternalPeer = false
  for (const id of relatedIds) {
    if (!ownIds.has(id) && getRepoIdFromWorktreeId(id) !== repo.id) {
      hasExternalPeer = true
      break
    }
  }
  if (!hasExternalPeer) {
    return projectResolvedWorktreeLineage(rows, lineageById)
  }
  const hostId = getRepoExecutionHostId(repo)
  const repos = store.getRepos()
  const reposById = new Map<string, Repo[]>()
  for (const candidate of repos) {
    const owners = reposById.get(candidate.id)
    if (owners) {
      owners.push(candidate)
    } else {
      reposById.set(candidate.id, [candidate])
    }
  }
  const metaById = readAllWorktreeMetaForHost(store, hostId)
  const peers: Worktree[] = []
  for (const id of relatedIds) {
    if (ownIds.has(id) || getRepoIdFromWorktreeId(id) === repo.id) {
      continue
    }
    const owners = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    let owner: Repo | undefined
    let hostOwnerCount = 0
    let invalidOwner = false
    for (const candidate of owners) {
      const evidence = resolveRepoOwnershipEvidence(candidate)
      if (evidence.status !== 'owned') {
        invalidOwner = true
        break
      }
      if (evidence.hostId === hostId) {
        owner = candidate
        hostOwnerCount += 1
      }
    }
    const meta = metaById[id]
    if (
      invalidOwner ||
      hostOwnerCount !== 1 ||
      !owner ||
      !meta ||
      (!meta.instanceId && !isFolderRepo(owner)) ||
      (!meta.hostId && owners.length > 1)
    ) {
      continue
    }
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
