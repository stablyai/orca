import { createHash } from 'node:crypto'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree, DetectedWorktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence/loading-store/store'
import { mergeWorktreeMetaForWrite } from '../../../persistence/loading-store/worktree-meta-write-normalization'
import { isWslMoveRepoBlocked } from '../../../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../../../persistence/host-qualified-worktree-meta'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'
import {
  toDetectedWorktree,
  applyMetadataFallbackVisibility
} from '../../../../shared/worktree/ownership'
import { projectWorktreeLineageWithHostPeers } from '../../../worktree-lineage-host-peers'
import { getProjectHostSetupMetaUpdates } from './worktree-discovery-metadata'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from '../folder-workspace-model'

// A project a WSL move is taking still lists, with its repairs projected in memory only.
function folderMetaWriter(
  store: Store,
  repo: Repo
): (worktreeId: string, updates: Partial<WorktreeMeta>) => WorktreeMeta {
  if (!isWslMoveRepoBlocked(repo)) {
    return (worktreeId, updates) => store.setWorktreeMeta(worktreeId, updates)
  }
  return (worktreeId, updates) => {
    const existing = store.getWorktreeMeta(worktreeId)
    // Nothing persists, so a minted root id would change on every listing; derive it instead.
    const instanceId =
      existing?.instanceId ??
      (worktreeId === getFolderWorkspaceRootId(repo)
        ? createHash('sha256').update(worktreeId).digest('hex').slice(0, 32)
        : getFolderWorkspaceInstanceIdentity(repo, worktreeId))
    return mergeWorktreeMetaForWrite(existing, { ...updates, instanceId })
  }
}

export function listFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  const writeMeta = folderMetaWriter(store, repo)
  const rootId = getFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const ids = Object.keys(allMeta).filter((worktreeId) =>
    isFolderWorkspaceIdForRepo(repo, worktreeId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  }

  return ids
    .map((worktreeId) => {
      const existing = allMeta[worktreeId]
      const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, existing)
      const meta =
        existing?.instanceId && Object.keys(ownershipUpdates).length === 0
          ? existing
          : writeMeta(worktreeId, {
              instanceId:
                existing?.instanceId ?? getFolderWorkspaceInstanceIdentity(repo, worktreeId),
              ...ownershipUpdates,
              ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
            })
      return mergeFolderWorkspace(repo, worktreeId, meta)
    })
    .sort((a, b) => {
      if (a.id === rootId) {
        return -1
      }
      if (b.id === rootId) {
        return 1
      }
      return (b.createdAt ?? b.lastActivityAt) - (a.createdAt ?? a.lastActivityAt)
    })
}

export function buildFolderDetectedWorktrees(store: Store, repo: Repo): DetectedWorktree[] {
  const settings = store.getSettings()
  const worktrees = listFolderWorkspaces(store, repo)
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...worktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  return worktrees.map((worktree) =>
    toDetectedWorktree({
      repo,
      worktree,
      meta: store.getWorktreeMeta(worktree.id),
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true,
      worktreeVisibilitySourceMatcher
    })
  )
}

export function listVisibleFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  const writeMeta = folderMetaWriter(store, repo)
  return buildFolderDetectedWorktrees(store, repo)
    .filter((worktree) => worktree.visible)
    .map((worktree) => {
      const meta = store.getWorktreeMeta(worktree.id)
      const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, meta)
      const repairedMeta =
        meta && Object.keys(ownershipUpdates).length === 0
          ? meta
          : writeMeta(worktree.id, ownershipUpdates)
      return mergeFolderWorkspace(repo, worktree.id, repairedMeta)
    })
}

export function buildDisconnectedDetectedWorktrees(
  store: Store,
  repo: Repo,
  worktrees: Worktree[],
  options: { hostMeta?: Record<string, WorktreeMeta> } = {}
): DetectedWorktree[] {
  const settings = store.getSettings()
  const hostId = getRepoExecutionHostId(repo)
  const hostMeta = options.hostMeta ?? readAllWorktreeMetaForHost(store, hostId)
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...worktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const detected = worktrees.map((worktree) => {
    const meta = readWorktreeMetaForHost(store, worktree.id, hostId) ?? hostMeta[worktree.id]
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true,
      worktreeVisibilitySourceMatcher
    })
    return applyMetadataFallbackVisibility(detected)
  })
  return projectWorktreeLineageWithHostPeers(store, repo, detected)
}
