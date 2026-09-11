import type { Repo } from '../../../../shared/repo-types'
import type { Worktree, DetectedWorktree } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'
import {
  toDetectedWorktree,
  applyMetadataFallbackVisibility
} from '../../../../shared/worktree/ownership'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import { getProjectHostSetupMetaUpdates } from './worktree-discovery-metadata'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from '../folder-workspace-model'

export function listFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
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
          : store.setWorktreeMeta(worktreeId, {
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
  return buildFolderDetectedWorktrees(store, repo)
    .filter((worktree) => worktree.visible)
    .map((worktree) => {
      const meta = store.getWorktreeMeta(worktree.id)
      const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, meta)
      const repairedMeta =
        meta && Object.keys(ownershipUpdates).length === 0
          ? meta
          : store.setWorktreeMeta(worktree.id, ownershipUpdates)
      return mergeFolderWorkspace(repo, worktree.id, repairedMeta)
    })
}

export function buildDisconnectedDetectedWorktrees(
  store: Store,
  repo: Repo,
  worktrees: Worktree[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...worktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const detected = worktrees.map((worktree) => {
    const meta = store.getWorktreeMeta(worktree.id)
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
  return projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
}
