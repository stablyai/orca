import { worktreeRemovalMembershipRevision } from '../../worktree-removal-table'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../../local-worktree-scan-generation'
import { knownWorktreeInventory, type WorktreeInventoryStore } from '../../known-worktree-inventory'
import type { WorktreeListingObservations } from '../../worktree-listing-observation'
import { retainKnownWorktreesInListing } from '../../known-worktree-listing-retention'
import { withUnregisteredRemovalCheckouts } from '../../worktree-removal-listing'
import { withoutInFlightWorktreeCreates } from '../../worktree-create-in-flight'
import { preserveFolderUpgradeWorktreePath } from '../../folder-upgrade-worktree-path'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'
import type { RuntimeWorktreeScanCache } from '../orca-runtime-core'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'

type RuntimeRepoListingOwner = {
  store: WorktreeInventoryStore
  observations: WorktreeListingObservations
  cache: Map<string, RuntimeWorktreeScanCache>
  generations: ReadonlyMap<string, number>
}

export async function observeRuntimeRepoWorktrees(
  owner: RuntimeRepoListingOwner,
  repo: Repo,
  readRaw: () => Promise<RuntimeWorktreeScanResult>,
  signal?: AbortSignal
): Promise<RuntimeWorktreeScanResult> {
  const { store, observations, cache, generations } = owner
  const inventory = knownWorktreeInventory(store)
  const removalRevision = worktreeRemovalMembershipRevision(repo.id)
  const scope = inventory.read(repo)
  const route = inventory.route(repo)
  const generation = getLocalWorktreeScanGeneration(repo.id)
  const scanKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
  const cacheGeneration = generations.get(scanKey)
  const current = () =>
    isLocalWorktreeScanGenerationCurrent(repo.id, generation) &&
    worktreeRemovalMembershipRevision(repo.id) === removalRevision &&
    inventory.read(repo) === scope &&
    inventory.route(repo) === route &&
    generations.get(scanKey) === cacheGeneration
  try {
    const observation = await observations.observe({
      key: scanKey,
      scope,
      route: `${repo.path}\0${route}\0${removalRevision}\0${generation}\0${cacheGeneration}`,
      ttlMs: resolveWorktreeScanCacheTtlMs(repo),
      reusable: inventory.reusable,
      signal,
      isCallerCurrent: () => !signal?.aborted,
      isProducerCurrent: current,
      run: async (producerSignal, isCurrent) => {
        const raw = await readRaw()
        const scan = { ...raw, worktrees: preserveFolderUpgradeWorktreePath(repo, raw.worktrees) }
        if (!isCurrent()) {
          throw new Error('Worktree listing superseded')
        }
        if (!scan.ok || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
          return { worktrees: scan.worktrees, confirmed: scan.ok }
        }
        const retained = await retainKnownWorktreesInListing(store, repo, scan.worktrees, {
          inventory: scope,
          gitOptions: inventory.gitOptions(repo),
          signal: producerSignal,
          isCurrent
        })
        return {
          confirmed: true,
          worktrees: await withUnregisteredRemovalCheckouts(
            repo.id,
            withoutInFlightWorktreeCreates(repo.id, retained),
            { signal: producerSignal, isCurrent }
          )
        }
      }
    })
    const listing: RuntimeWorktreeScanResult = {
      ok: observation.confirmed,
      worktrees: observation.worktrees,
      isCurrent: observation.isCurrent
    }
    const cached = cache.get(scanKey)
    if (cached && listing.ok && observation.isCurrent()) {
      cached.listing = listing
    }
    return listing
  } catch {
    return { ok: false, worktrees: [], isCurrent: current }
  }
}
