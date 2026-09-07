import { ipcMain } from 'electron'
import type {
  ListKnownWorktreesForExecutionHostArgs,
  HostQualifiedKnownWorktreeResult,
  ForgetRemovedWorktreesForExecutionHostArgs,
  ForgetRemovedWorktreesForExecutionHostResult
} from '../../../../shared/detected-worktree-provider-contract'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
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

export function registerHostCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'worktrees:listKnownForExecutionHost',
    (_event, args: ListKnownWorktreesForExecutionHostArgs): HostQualifiedKnownWorktreeResult => {
      // Why: a malformed invoke must fail closed as `rejected`, not throw out of the handler. `ssh:` is inert —
      // it owns no repo, so every guard below still rejects it.
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
      // Why: findExactRepoOwner repeats this same all-candidates-owned check, and getRepos() re-hydrates the
      // whole catalog, so a separate pass here is pure cost.
      const repo = findExactRepoOwner(store, requestedRepoId, requestedExecutionHostId)
      if (!repo || repo.connectionId !== parsedHost.targetId) {
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
      // Why: folder workspace ids carry an instance suffix the git-worktree synthesizer would read as a directory; build them the way every other listing does.
      if (isFolderRepo(repo)) {
        const folderWorkspaceIds = Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) =>
          isFolderWorkspaceIdForRepo(repo, worktreeId)
        )
        return hasConflictingStoredWorktreeOwner(store, repo, folderWorkspaceIds)
          ? rejected()
          : complete(
              // Why: match the authoritative folder listing; without lineage these rows render flat and then
              // reshuffle once the real scan lands.
              projectResolvedWorktreeLineage(
                buildFolderDetectedWorktrees(store, repo),
                store.getAllWorktreeLineage?.() ?? {}
              )
            )
      }
      const metaIndex = createSshWorktreeMetaIndexForRepo(
        readAllWorktreeMetaForHost(store, requestedExecutionHostId),
        repo.id
      )
      return complete(
        buildDisconnectedDetectedWorktrees(
          store,
          repo,
          listDisconnectedSshWorktrees(store, repo, metaIndex)
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
      // Runtime hosts belong here for the same reason SSH ones do: their rows are exempt from
      // gcStaleWorktreeMeta, so a scan-proven removal is the only thing that ever retires them.
      if (
        (parsedHost?.kind !== 'ssh' && parsedHost?.kind !== 'runtime') ||
        worktreeIds.length === 0
      ) {
        return nothingForgotten
      }
      // No runtime arm in the check below: `findExactRepoOwner` already refuses a repo carrying both
      // a runtime `executionHostId` and a `connectionId`, because `resolveRepoOwnershipEvidence`
      // calls that pair contradictory and one non-owned candidate voids the whole lookup. A second
      // check would be unreachable, and unreachable code on a destructive path reads as a guarantee
      // it is not making.
      const repo = findExactRepoOwner(store, args?.repoId ?? '', requestedExecutionHostId)
      if (!repo || (parsedHost.kind === 'ssh' && repo.connectionId !== parsedHost.targetId)) {
        return nothingForgotten
      }
      // Why: a folder workspace's meta IS the workspace record, not a checkout row — gcStaleWorktreeMeta skips
      // those keys for the same reason, and no remote scan can retire one.
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
        // An unhosted meta belongs to this repo's only owner; a foreign hostId needs that host's own scan.
        if (meta.hostId && meta.hostId !== requestedExecutionHostId) {
          continue
        }
        store.removeWorktreeMeta(worktreeId, requestedExecutionHostId)
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
