import type { Repo } from '../../shared/repo-types'
import { scanUntilNotOvertaken } from '../ipc/worktrees/listing/overtaken-scan-rerun'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../local-worktree-scan-generation'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { Store } from '../persistence'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

export type WitnessedRuntimeWorktreeScan = RuntimeWorktreeScanResult & {
  /** A worktree change landed while this scan ran; its rows describe a catalog that is gone. */
  superseded: boolean
  scanGeneration: number
  metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
}

/**
 * The destructive scan expectation for one repo, or undefined when this repo must not carry one.
 *
 * WSL-routed repos are excluded for the same reason the desktop listing excludes them: the listing
 * runs in the distro and reports Linux paths while metadata can hold UNC ones, and v1 cannot prove
 * those aliases equivalent. A runtime that needs repair throws rather than resolving routing, which
 * is likewise no basis for deleting rows.
 */
function captureLocalMetadataPruneExpectation(
  store: RuntimeStore,
  repo: Repo
): NativeLocalWorktreeMetadataScanExpectation | undefined {
  if (typeof store.captureNativeLocalWorktreeMetadataScanExpectation !== 'function') {
    return undefined
  }
  try {
    if (getLocalProjectWorktreeGitOptions(store as unknown as Store, repo).wslDistro) {
      return undefined
    }
  } catch {
    return undefined
  }
  return store.captureNativeLocalWorktreeMetadataScanExpectation(repo)
}

// Why the witness is the process-wide scan generation: it is what every worktree change
// invalidator bumps, in the desktop and the headless host alike, and the runtime scan cache the
// scan reads through is cleared by the same invalidators, so a re-run lists again.
async function scanRuntimeWorktreesWithMutationWitness(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WitnessedRuntimeWorktreeScan> {
  // Why capture before the scan: listing can mutate metadata synchronously before its first
  // await, and the prune revalidates against the rows as they stood when the scan was issued.
  const scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  const metadataPruneExpectation = captureLocalMetadataPruneExpectation(store, repo)
  let scan: RuntimeWorktreeScanResult
  try {
    scan = await scanRepo(repo)
  } catch {
    scan = { ok: false, worktrees: [] }
  }
  return {
    ...scan,
    // Why only a scan that succeeded: a failed one is already published non-authoritative.
    superseded: scan.ok && !isLocalWorktreeScanGenerationCurrent(repo.id, scanGeneration),
    scanGeneration,
    metadataPruneExpectation
  }
}

/** The repo's scan, re-run under the shared bound while a worktree change overtakes it. */
export function scanRuntimeWorktreesUntilNotOvertaken(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WitnessedRuntimeWorktreeScan> {
  return scanUntilNotOvertaken(
    repo.id,
    () => scanRuntimeWorktreesWithMutationWitness(store, repo, scanRepo),
    () => true
  )
}
