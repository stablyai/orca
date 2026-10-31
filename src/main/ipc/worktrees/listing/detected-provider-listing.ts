import { knownWorktreeInventory } from '../../../known-worktree-inventory'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from '../../../worktree-removal-listing'
import { getRepoDialableSshTargetId } from '../../../../shared/execution-host'
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
  detectedListingObservations,
  DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'
import {
  getLocalWorktreeCatalogVersion,
  isLocalWorktreeScanGenerationCurrent,
  getLocalWorktreeScanGeneration,
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
import {
  retainKnownWorktreesInListing,
  KnownWorktreeListingError
} from '../../../known-worktree-listing-retention'
import { releaseWslStoppedWorktreeRescan } from '../../../wsl-stopped-worktree-rescan-registry'
import {
  listWslStoppedWorktrees,
  rescanWorktreesWhenWslDistroRuns,
  wslDistroNotRunningForScanFailure
} from './wsl-stopped-worktree-listing'

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
  const allMeta = connectionId ? readAllWorktreeMetaForRepo(store, repo) : undefined

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
    const inventory = knownWorktreeInventory(store)
    const scan = await scanUntilNotOvertaken(
      repo.id,
      async () => {
        const generation = getLocalWorktreeScanGeneration(repo.id)
        const scope = inventory.read(repo)
        const route = inventory.route(repo)
        const producerCurrent = () =>
          isLocalWorktreeScanGenerationCurrent(repo.id, generation) &&
          inventory.read(repo) === scope &&
          inventory.route(repo) === route
        try {
          const observation = await detectedListingObservations(store).observe({
            key: repo.id,
            scope,
            route: `${repo.path}\0${route}\0${generation}`,
            ttlMs: DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
            reusable: inventory.reusable,
            signal: providerAbort?.signal,
            isCallerCurrent: isCurrent,
            isProducerCurrent: producerCurrent,
            run: async (signal, current) => {
              const raw = await listDetectedGitWorktrees(store, repo)
              if (raw.superseded || !current()) {
                throw new Error('Worktree listing superseded')
              }
              const retained = await retainKnownWorktreesInListing(store, repo, raw.gitWorktrees, {
                inventory: scope,
                gitOptions: inventory.gitOptions(repo),
                signal,
                isCurrent: current
              })
              const rows = await withUnregisteredRemovalCheckouts(
                repo.id,
                withoutInFlightWorktreeCreates(repo.id, retained),
                { signal, isCurrent: current }
              )
              if (!current()) {
                throw new Error('Worktree listing superseded')
              }
              if (
                hasConflictingStoredWorktreeOwner(
                  store,
                  repo,
                  rows.map((row) => `${repo.id}::${row.path}`)
                )
              ) {
                throw new KnownWorktreeListingError(new Error('Conflicting worktree owner'))
              }
              if (
                raw.fresh &&
                !(await applyFreshDetectedWorktreeScanSideEffects(
                  store,
                  repo,
                  retained,
                  raw.metadataPrune,
                  {
                    isCurrent: current,
                    sideEffectToken: raw.sideEffectToken,
                    signal,
                    hygieneDue: raw.hygieneDue
                  }
                ))
              ) {
                throw new KnownWorktreeListingError(new Error('Worktree listing commit superseded'))
              }
              return { worktrees: rows, confirmed: true }
            }
          })
          return { generation, observation, superseded: !producerCurrent() }
        } catch (error) {
          if (isCurrent() && producerCurrent()) {
            throw error
          }
          return { generation, observation: null, superseded: true }
        }
      },
      () => isCurrent() && !providerAbort?.signal.aborted
    )
    if (scan.superseded || !scan.observation?.isCurrent()) {
      return abortedResult() ?? null
    }
    const localRows = scan.observation.worktrees
    const aborted = abortedResult()
    if (aborted) {
      return aborted
    }
    if (!isCurrent()) {
      return null
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    releaseWslStoppedWorktreeRescan(repo.id)
    // Rows describe scan-start generation, which clients order against applied create/remove replies.
    return {
      repoId: repo.id,
      authoritative: true,
      source: 'git',
      catalogVersion: localWorktreeCatalogVersionAt(scan.generation),
      worktrees: projectPendingWorktreeRemovals(
        buildDetectedGitWorktrees(store, repo, localRows, inventory.read(repo).meta),
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
    const retentionFailure = err instanceof KnownWorktreeListingError
    const failure = retentionFailure ? err.cause : err
    const unavailableReason = describeWorktreeScanFailure(failure)
    const failureKind = classifyWorktreeScanFailure(unavailableReason)
    // A distro the gate would not start (E9) is expected: keep stored rows and re-list once it runs.
    const wslDistroStopped = wslDistroNotRunningForScanFailure(failure)
    if (wslDistroStopped) {
      rescanWorktreesWhenWslDistroRuns(repo.id, wslDistroStopped.distro)
      return {
        repoId: repo.id,
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: retentionFailure ? [] : listWslStoppedWorktrees(store, repo, allMeta),
        unavailableReason,
        failureKind,
        wslDistroStopped,
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id)
      }
    }
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
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
