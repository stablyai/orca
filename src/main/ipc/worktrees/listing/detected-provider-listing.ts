import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from '../../../workspaces/removal/worktree-removal-listing'
import { getRepoDialableSshTargetId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { projectWorktreeLineageWithHostPeers } from '../../../workspaces/catalog/worktree-lineage-host-peers'
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
  isLocalWorktreeScanGenerationCurrent,
  localWorktreeCatalogVersionAt
} from '../../../workspaces/catalog/local-worktree-scan-generation'
import {
  describeWorktreeScanFailure,
  loggedWorktreeListFailures,
  warnOnce
} from './worktree-listing-diagnostics'
import { readAllWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { classifyWorktreeScanFailure } from '../../../../shared/worktree-scan-failure'
import { scanUntilNotOvertaken } from './overtaken-scan-rerun'
import { withoutInFlightWorktreeCreates } from '../../../workspaces/creation/worktree-create-in-flight'
import { releaseWslStoppedWorktreeRescan } from '../../../wsl/discovery/wsl-stopped-worktree-rescan-registry'
import {
  listWslStoppedWorktrees,
  rescanWorktreesWhenWslDistroRuns,
  wslDistroNotRunningForScanFailure
} from './wsl-stopped-worktree-listing'
import {
  gitWorktreeObservationReader,
  captureGitWorktreeObservationCommit
} from '../../../workspaces/catalog/git-worktree-observations'

// Partial stores (tests, embedders) may not publish workspace metadata; their listings carry no stamp.
function readWorkspaceMetadataCursor(store: {
  getWorkspaceMetadataCursor?: () => { epoch: string; seq: number }
}): { epoch: string; seq: number } | undefined {
  return store.getWorkspaceMetadataCursor?.()
}

export async function listDetectedWorktreesForCapturedRepo(
  store: Store,
  repo: Repo,
  isCurrent: () => boolean,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<DetectedWorktreeListResult | { providerAbortStatus: 'canceled' | 'timed-out' } | null> {
  // Unserved SSH ownership permits metadata listing only, never local Git.
  const connectionId = getRepoDialableSshTargetId(repo)
  const abortedResult = () =>
    providerAbort?.signal.aborted
      ? ({ providerAbortStatus: providerAbort.status() } as const)
      : undefined
  const allMeta = isFolderRepo(repo) ? undefined : readAllWorktreeMetaForRepo(store, repo)
  // Read with the metadata, so clients can tell which published metadata records this listing includes.
  const workspaceMetadata = readWorkspaceMetadataCursor(store)

  try {
    // Folder rows are read synchronously, leaving no mutation window that needs a re-scan.
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
          catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
          ...(workspaceMetadata ? { workspaceMetadata } : {})
        }
      }
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        ...(workspaceMetadata ? { workspaceMetadata } : {}),
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
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        ...(workspaceMetadata ? { workspaceMetadata } : {})
      }
    }
    const pendingAtScan = snapshotPendingWorktreeRemovals()
    const scan = await scanUntilNotOvertaken(
      repo.id,
      () =>
        listDetectedGitWorktrees(store, repo, () =>
          captureGitWorktreeObservationCommit(store, repo)
        ),
      () => isCurrent() && !providerAbort?.signal.aborted
    )
    // Stale rejection preserves client rows; non-authoritative replacement could hide newly created worktrees.
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
    if (!isCurrent() || !isLocalWorktreeScanGenerationCurrent(repo.id, scan.generation)) {
      return null
    }
    const listedWorktreeIds = gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`)
    if (hasConflictingStoredWorktreeOwner(store, repo, listedWorktreeIds)) {
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: [],
        catalogVersion: localWorktreeCatalogVersionAt(scan.generation),
        ...(workspaceMetadata ? { workspaceMetadata } : {})
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
      if (
        !isCurrent() ||
        !isLocalWorktreeScanGenerationCurrent(repo.id, scan.generation) ||
        (scan.observationCommit && !scan.observationCommit.isCurrent())
      ) {
        return null
      }
      scan.observationCommit?.commit(gitWorktrees)
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    releaseWslStoppedWorktreeRescan(repo.id)
    // Rows describe scan-start generation, which clients order against applied create/remove replies.
    return {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      catalogVersion: localWorktreeCatalogVersionAt(scan.generation),
      ...(workspaceMetadata ? { workspaceMetadata } : {}),
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
    // Retained rows need their scan-failure cause to explain why they are unavailable.
    const unavailableReason = describeWorktreeScanFailure(err)
    const failureKind = classifyWorktreeScanFailure(unavailableReason)
    const fallbackMeta = readAllWorktreeMetaForRepo(store, repo)
    const fallbackMetadata = readWorkspaceMetadataCursor(store)
    // A distro the gate would not start (E9) is expected: keep stored rows and re-list once it runs.
    const wslDistroStopped = wslDistroNotRunningForScanFailure(err)
    if (wslDistroStopped) {
      rescanWorktreesWhenWslDistroRuns(repo.id, wslDistroStopped.distro)
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: listWslStoppedWorktrees(store, repo, fallbackMeta),
        unavailableReason,
        failureKind,
        wslDistroStopped,
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        ...(fallbackMetadata ? { workspaceMetadata: fallbackMetadata } : {})
      }
    }
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
    const readObservation = gitWorktreeObservationReader(store, repo)
    return {
      repoId: repo.id,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: buildDisconnectedDetectedWorktrees(
        store,
        repo,
        listDisconnectedSshWorktrees(
          store,
          repo,
          createSshWorktreeMetaIndex(Object.entries(fallbackMeta))
        ).filter((row) => readObservation(fallbackMeta[row.id]))
      ),
      unavailableReason,
      failureKind,
      catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
      ...(fallbackMetadata ? { workspaceMetadata: fallbackMetadata } : {})
    }
  }
}

export function hasValidDirectSshAuthority(
  args: DirectSshDetectedWorktreeRequest
): args is DirectSshDetectedWorktreeRequest {
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}
