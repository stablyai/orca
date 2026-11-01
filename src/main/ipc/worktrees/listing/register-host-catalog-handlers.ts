import { getRepoDialableSshTargetId, parseExecutionHostId } from '../../../../shared/execution-host'
import { ipcMain } from 'electron'
import type {
  ListKnownWorktreesForExecutionHostArgs,
  HostQualifiedKnownWorktreeResult,
  ForgetRemovedWorktreesForExecutionHostArgs,
  ForgetRemovedWorktreesForExecutionHostResult
} from '../../../../shared/detected-worktree-provider-contract'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { projectWorktreeLineageWithHostPeers } from '../../../worktree-lineage-host-peers'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { agentHookServer } from '../../../agent-hooks/server'
import { pruneWorkspaceCleanupScanSnapshots } from '../../../workspace-cleanup-scan-snapshot'
import { pruneWorkspaceSpaceAnalysisSnapshots } from '../../../workspace-space-analysis-snapshot'
import { findExactRepoOwner, hasConflictingStoredWorktreeOwner } from './worktree-host-ownership'
import {
  buildDisconnectedDetectedWorktrees,
  buildFolderDetectedWorktrees
} from './folder-workspace-catalog'
import { isFolderWorkspaceIdForRepo } from '../folder-workspace-model'
import {
  createSshWorktreeMetaIndexForRepo,
  listDisconnectedSshWorktrees
} from './ssh-worktree-fallback'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

export function registerHostCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'worktrees:listKnownForExecutionHost',
    (_event, args: ListKnownWorktreesForExecutionHostArgs): HostQualifiedKnownWorktreeResult => {
      // Malformed requests return rejected; the inert ssh: fallback resolves no owner.
      const requestedRepoId = args?.repoId ?? ''
      const requestedExecutionHostId = args?.executionHostId ?? 'ssh:'
      const rejected = (): HostQualifiedKnownWorktreeResult => ({
        status: 'rejected',
        repoId: requestedRepoId,
        executionHostId: requestedExecutionHostId
      })
      const parsedHost = parseExecutionHostId(requestedExecutionHostId)
      if (parsedHost?.kind !== 'ssh') {
        return rejected()
      }
      // Exact-owner lookup already checks every candidate; avoid rehydrating the catalog twice.
      const repo = findExactRepoOwner(store, requestedRepoId, requestedExecutionHostId)
      if (!repo || getRepoDialableSshTargetId(repo) !== parsedHost.targetId) {
        return rejected()
      }
      const complete = (worktrees: DetectedWorktree[]): HostQualifiedKnownWorktreeResult => ({
        status: 'complete',
        repoId: repo.id,
        executionHostId: requestedExecutionHostId,
        result: {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees
        }
      })
      // Folder instance suffixes require the folder builder rather than Git path synthesis.
      if (isFolderRepo(repo)) {
        const folderWorkspaceIds = Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) =>
          isFolderWorkspaceIdForRepo(repo, worktreeId)
        )
        return hasConflictingStoredWorktreeOwner(store, repo, folderWorkspaceIds)
          ? rejected()
          : complete(
              projectWorktreeLineageWithHostPeers(
                store,
                repo,
                buildFolderDetectedWorktrees(store, repo)
              )
            )
      }
      const hostMeta = readAllWorktreeMetaForHost(store, requestedExecutionHostId)
      const metaIndex = createSshWorktreeMetaIndexForRepo(hostMeta, repo.id)
      return complete(
        buildDisconnectedDetectedWorktrees(
          store,
          repo,
          listDisconnectedSshWorktrees(store, repo, metaIndex),
          { hostMeta }
        )
      )
    }
  )

  ipcMain.handle(
    'worktrees:forgetRemovedForExecutionHost',
    (
      _event,
      args: ForgetRemovedWorktreesForExecutionHostArgs
    ): ForgetRemovedWorktreesForExecutionHostResult => {
      const nothingForgotten: ForgetRemovedWorktreesForExecutionHostResult = {
        forgottenWorktreeIds: []
      }
      const requestedExecutionHostId = args?.executionHostId ?? 'ssh:'
      const worktreeIds = Array.isArray(args?.worktreeIds) ? args.worktreeIds : []
      const parsedHost = parseExecutionHostId(requestedExecutionHostId)
      // SSH/runtime rows bypass local stale GC; authoritative host scans must retire them.
      if (
        (parsedHost?.kind !== 'ssh' && parsedHost?.kind !== 'runtime') ||
        worktreeIds.length === 0
      ) {
        return nothingForgotten
      }
      // Exact-owner lookup rejects contradictory runtime/connection ownership before destructive work.
      const repo = findExactRepoOwner(store, args?.repoId ?? '', requestedExecutionHostId)
      if (!repo || (parsedHost.kind === 'ssh' && repo.connectionId !== parsedHost.targetId)) {
        return nothingForgotten
      }
      // Folder metadata is the workspace itself; a remote filesystem scan cannot prove it removed.
      if (isFolderRepo(repo)) {
        return nothingForgotten
      }
      const allMeta = readAllWorktreeMetaForHost(store, requestedExecutionHostId)
      const forgottenWorktreeIds: string[] = []
      for (const worktreeId of worktreeIds) {
        const meta = typeof worktreeId === 'string' ? allMeta[worktreeId] : undefined
        if (!meta || getRepoIdFromWorktreeId(worktreeId) !== repo.id) {
          continue
        }
        // Legacy unhosted rows belong to the sole owner; foreign rows require their own host's scan.
        if (meta.hostId && meta.hostId !== requestedExecutionHostId) {
          continue
        }
        store.removeWorktreeMeta(
          hostWorktreeTarget({ id: worktreeId, hostId: requestedExecutionHostId })
        )
        // Off-host rows bypass local GC, so this removal must also retire persisted agent status.
        agentHookServer.dropStatusEntriesForRemovedWorktree(worktreeId, parsedHost.id)
        forgottenWorktreeIds.push(worktreeId)
      }
      if (forgottenWorktreeIds.length > 0) {
        const snapshotDirectory = store.getProfileStorageDirectory()
        const targets = forgottenWorktreeIds.map((worktreeId) => ({
          worktreeId,
          executionHostId: requestedExecutionHostId
        }))
        void pruneWorkspaceCleanupScanSnapshots(snapshotDirectory, targets)
        void pruneWorkspaceSpaceAnalysisSnapshots(snapshotDirectory, targets)
      }
      return { forgottenWorktreeIds }
    }
  )
}
