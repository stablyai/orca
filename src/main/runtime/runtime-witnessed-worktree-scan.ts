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
  /** A concurrent worktree change made these scan rows stale. */
  superseded: boolean
  scanGeneration: number
  metadataPruneExpectation: NativeLocalWorktreeMetadataScanExpectation | undefined
}

/** Refuse destructive pruning on unresolved routes or WSL, whose Linux paths v1 cannot equate with stored UNC aliases. */
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

// Desktop and headless invalidators share this generation and clear the runtime scan cache, so retries list afresh.
async function scanRuntimeWorktreesWithMutationWitness(
  store: RuntimeStore,
  repo: Repo,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WitnessedRuntimeWorktreeScan> {
  // Capture before listing can mutate metadata synchronously; pruning revalidates the original rows.
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
    // Failed scans are already non-authoritative.
    superseded: scan.ok && !isLocalWorktreeScanGenerationCurrent(repo.id, scanGeneration),
    scanGeneration,
    metadataPruneExpectation
  }
}

/** Rerun overtaken scans within the shared retry bound. */
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
