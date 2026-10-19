import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from '../../../worktree-removal-listing'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { projectWorktreeLineageWithHostPeers } from '../../../worktree-lineage-host-peers'
import type { DirectSshDetectedWorktreeRequest } from '../../../../shared/detected-worktree-provider-contract'
import { isAdmissibleDirectSshAuthority } from '../../../../shared/ssh-retained-payload-admission'
import {
  buildDetectedGitWorktrees,
  createSshWorktreeMetaIndex,
  listDisconnectedSshWorktrees
} from './ssh-worktree-fallback'
import {
  buildDisconnectedDetectedWorktrees,
  buildFolderDetectedWorktrees
} from './folder-workspace-catalog'
import { isFolderWorkspaceIdForRepo } from '../folder-workspace-model'
import { hasConflictingStoredWorktreeOwner } from './worktree-host-ownership'
import {
  applyFreshDetectedWorktreeScanSideEffects,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'
import {
  getLocalWorktreeCatalogVersion,
  localWorktreeCatalogVersionAt
} from '../../../local-worktree-scan-generation'
import {
  describeWorktreeScanFailure,
  loggedWorktreeListFailures,
  warnOnce
} from './worktree-listing-diagnostics'
import { readAllWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { classifyWorktreeScanFailure } from '../../../../shared/worktree-scan-failure'
import { scanUntilNotOvertaken } from './overtaken-scan-rerun'
import { withoutInFlightWorktreeCreates } from '../../../worktree-create-in-flight'

export async function listDetectedWorktreesForCapturedRepo(
  store: Store,
  repo: Repo,
  isCurrent: () => boolean,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<DetectedWorktreeListResult | { providerAbortStatus: 'canceled' | 'timed-out' } | null> {
  // An `ssh:` repo is not served here, so it lists from metadata, never from this machine's git.
  const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
  const abortedResult = () =>
    providerAbort?.signal.aborted
      ? ({ providerAbortStatus: providerAbort.status() } as const)
      : undefined
  const allMeta = isFolderRepo(repo) ? undefined : readAllWorktreeMetaForRepo(store, repo)

  try {
    // Why no re-scan for folder repos: their rows come from the store synchronously below, so no
    // mutation can land under the read.
    if (isFolderRepo(repo)) {
      if (!isCurrent()) {
        return null
      }
      const folderWorkspaceIds = Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) =>
        isFolderWorkspaceIdForRepo(repo, worktreeId)
      )
      if (hasConflictingStoredWorktreeOwner(store, repo, folderWorkspaceIds)) {
        return {
          repoId: repo.id,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: [],
          catalogVersion: getLocalWorktreeCatalogVersion(repo.id)
        }
      }
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        worktrees: projectWorktreeLineageWithHostPeers(
          store,
          repo,
          buildFolderDetectedWorktrees(store, repo)
        )
      }
    }
    if (connectionId) {
      const aborted = abortedResult()
      if (aborted) {
        return aborted
      }
      if (!isCurrent()) {
        return null
      }
      const worktrees = listDisconnectedSshWorktrees(
        store,
        repo,
        createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
      )
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees),
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id)
      }
    }
    const pendingAtScan = snapshotPendingWorktreeRemovals()
    const scan = await scanUntilNotOvertaken(
      repo.id,
      () => listDetectedGitWorktrees(store, repo),
      () => isCurrent() && !providerAbort?.signal.aborted
    )
    // Why stale past the bound rather than a non-authoritative answer: non-authoritative rows still
    // replace the client's rows for this host, so a worktree the last overtaking mutation created
    // would vanish from the sidebar until the next listing. A stale rejection leaves client state
    // untouched; the overtaking mutation's own change event, sent after its generation bump and
    // therefore ahead of this reply, is what brings the listing that reflects it.
    if (scan.superseded) {
      return abortedResult() ?? null
    }
    const { gitWorktrees, fresh: freshScan, sideEffectToken, metadataPrune, hygieneDue } = scan
    const localRows = await withUnregisteredRemovalCheckouts(
      repo.id,
      withoutInFlightWorktreeCreates(repo.id, gitWorktrees)
    )
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    const listedWorktreeIds = gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`)
    if (hasConflictingStoredWorktreeOwner(store, repo, listedWorktreeIds)) {
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: [],
        catalogVersion: localWorktreeCatalogVersionAt(scan.generation)
      }
    }
    if (freshScan) {
      await applyFreshDetectedWorktreeScanSideEffects(store, repo, gitWorktrees, metadataPrune, {
        isCurrent: () => isCurrent() && !providerAbort?.signal.aborted,
        sideEffectToken,
        signal: providerAbort?.signal,
        ...(hygieneDue === undefined ? {} : { hygieneDue })
      })
      const aborted = abortedResult()
      if (aborted) {
        return aborted
      }
      if (!isCurrent()) {
        return null
      }
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    // Why the scan's generation, not the current one: the rows describe the catalog as of when the
    // scan began. A client orders this against the create and remove replies it has applied.
    return {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      catalogVersion: localWorktreeCatalogVersionAt(scan.generation),
      // Why always marked: the desktop renderer ships with this main process.
      worktrees: projectPendingWorktreeRemovals(
        buildDetectedGitWorktrees(store, repo, localRows, allMeta),
        (worktree) => worktree.id,
        true,
        pendingAtScan
      )
    }
  } catch (err) {
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
    // Why: retention alone leaves inert rows with no explanation; the cause rides with the listing.
    const unavailableReason = describeWorktreeScanFailure(err)
    const failureKind = classifyWorktreeScanFailure(unavailableReason)
    return {
      repoId: repo.id,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: [],
      unavailableReason,
      failureKind,
      catalogVersion: getLocalWorktreeCatalogVersion(repo.id)
    }
  }
}

export function hasValidDirectSshAuthority(
  args: DirectSshDetectedWorktreeRequest
): args is DirectSshDetectedWorktreeRequest {
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}
