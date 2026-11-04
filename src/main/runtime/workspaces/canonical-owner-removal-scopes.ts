import { isDeepStrictEqual } from 'node:util'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getLocalWorktreeScanGeneration } from '../../workspaces/catalog/local-worktree-scan-generation'
import type { RuntimeStore } from '../runtime-store-contract'
import {
  captureCanonicalOwnerRemoval,
  type OpenNativeOwnerRemovalStore
} from './canonical-owner-removal'
import {
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../../persistence/restoring-sessions/session-owner-removal'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../workspaces/removal/worktree-removal-repo-owner'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export function captureWorktreeOwnerRemoval(
  store: RuntimeStore,
  worktreeId: string,
  hostId?: ExecutionHostId,
  openNative?: OpenNativeOwnerRemovalStore
) {
  const identity = () => {
    const meta = store.getWorktreeMeta(worktreeId)
    return [meta?.hostId, meta?.createdAt, meta?.orcaCreatedAt]
  }
  const expected = identity()
  const persistedOwner = store.getWorktreeMeta(worktreeId)?.hostId
  const owner = hostId ?? persistedOwner
  const ownerPartition = workspaceSessionOwnerPartitionForHost(owner)
  const preserveSibling = Boolean(
    (hostId && persistedOwner && persistedOwner !== hostId) ||
    (owner &&
      hasWorktreeRemovalRepoOwnerOnOtherHost(
        store,
        getRepoIdFromWorktreeId(worktreeId),
        ownerPartition
      ))
  )
  const partitions = new Set(
    workspaceSessionPartitionIdsForHost(owner).filter(
      (partition) => !preserveSibling || partition === ownerPartition
    )
  )
  return captureCanonicalOwnerRemoval(
    store,
    (host, surface) => partitions.has(host) && surface.workspaceId === worktreeId,
    openNative,
    () => {
      if (isWslMoveSourceHost(owner)) {
        assertWslMoveWorkspaceWritable(store, worktreeId)
      }
      if (!isDeepStrictEqual(expected, identity())) {
        throw new Error('Workspace registration changed during removal. Try again.')
      }
    }
  )
}

export function captureRepositoryOwnerRemoval(
  store: RuntimeStore,
  target: RepoHostTarget,
  openNative?: OpenNativeOwnerRemovalStore,
  validate: () => void = () => {}
) {
  const hostId = getRepoExecutionHostId(target)
  const scoped =
    parseExecutionHostId(hostId)?.kind === 'runtime' ||
    store
      .getRepos()
      .some((repo) => repo.id === target.id && getRepoExecutionHostId(repo) !== hostId)
  const generation = getLocalWorktreeScanGeneration(target.id)
  return captureCanonicalOwnerRemoval(
    store,
    (host, surface) =>
      (!scoped || host === hostId) && getRepoIdFromWorktreeId(surface.workspaceId) === target.id,
    openNative,
    () => {
      validate()
      if (generation !== getLocalWorktreeScanGeneration(target.id)) {
        throw new Error('Project registration changed during removal. Try again.')
      }
    }
  )
}

export function captureFolderOwnerRemoval(
  store: RuntimeStore,
  id: string,
  openNative?: OpenNativeOwnerRemovalStore
) {
  const identity = () => {
    const folder = store.getFolderWorkspaces?.().find((row) => row.id === id)
    return folder && [folder.id, folder.createdAt, folder.folderPath, folder.projectGroupId]
  }
  const expected = identity()
  return captureCanonicalOwnerRemoval(
    store,
    (_host, surface) => surface.workspaceId === folderWorkspaceKey(id),
    openNative,
    () => {
      if (!isDeepStrictEqual(expected, identity())) {
        throw new Error('Folder workspace changed during removal. Try again.')
      }
    }
  )
}

export function captureProjectGroupOwnerRemoval(
  store: RuntimeStore,
  id: string,
  openNative?: OpenNativeOwnerRemovalStore
) {
  const scope = () => {
    const groups = store.getProjectGroups?.() ?? []
    const ids = getProjectGroupSubtreeIds(groups, id)
    return {
      groups: groups
        .filter((row) => ids.has(row.id))
        .map((row) => [row.id, row.createdAt, row.parentGroupId])
        .sort(),
      folders: (store.getFolderWorkspaces?.() ?? [])
        .filter((row) => ids.has(row.projectGroupId))
        .map((row) => [row.id, row.createdAt, row.projectGroupId, row.folderPath])
        .sort()
    }
  }
  const expected = scope()
  const workspaces = new Set<string>(
    expected.folders.map(([folderId]) => folderWorkspaceKey(String(folderId)))
  )
  return captureCanonicalOwnerRemoval(
    store,
    (_host, surface) => workspaces.has(surface.workspaceId),
    openNative,
    () => {
      if (!isDeepStrictEqual(expected, scope())) {
        throw new Error('Project group contents changed during removal. Try again.')
      }
    }
  )
}
