import type { Repo } from '../../shared/repo-types'
import type { SpotlightError, SpotlightRepoState } from '../../shared/spotlight'
import type {
  SpotlightActivateOutcome,
  SpotlightGitContext,
  SpotlightSyncOutcome
} from '../../shared/spotlight-sync-core'
import { splitWorktreeId } from '../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { SpotlightCoreError } from '../../shared/spotlight-sync-core'
import { isFolderRepo } from '../../shared/repo-kind'
import { createLocalSpotlightGitContext } from '../git/spotlight-sync'
import type { Store } from '../persistence'

export type ResolvedRepoContext =
  | { repo: Repo; ctx: SpotlightGitContext }
  | { error: SpotlightError }

/** Re-check Spotlight eligibility in main, not just the UI: activate/sync reset
 *  the root, so a renderer bug or crafted IPC must not rewrite a repo that never
 *  opted in. `requireEnabled: false` skips only the opt-in flag so deactivate can
 *  still restore the root after the toggle is turned off mid-session. */
export function resolveRepoContext(
  store: Store,
  repoId: string,
  opts: { requireEnabled?: boolean } = {}
): ResolvedRepoContext {
  const repo = store.getRepo(repoId)
  if (!repo) {
    return { error: { code: 'repo-not-found', message: `Unknown repository: ${repoId}` } }
  }
  if (isFolderRepo(repo)) {
    return { error: { code: 'not-enabled', message: 'Spotlight testing needs a git repository.' } }
  }
  if (repo.connectionId?.trim()) {
    return {
      error: {
        code: 'unsupported-host',
        message: 'Spotlight testing is not available for SSH repositories yet.'
      }
    }
  }
  if (opts.requireEnabled !== false && repo.spotlightTestingEnabled !== true) {
    return {
      error: { code: 'not-enabled', message: 'Spotlight testing is not enabled for this project.' }
    }
  }
  try {
    return { repo, ctx: createLocalSpotlightGitContext(store, repo) }
  } catch (error) {
    return { error: toSpotlightError(error) }
  }
}

export function toSpotlightError(error: unknown): SpotlightError {
  if (error instanceof SpotlightCoreError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'git-failed', message: error instanceof Error ? error.message : String(error) }
}

/** Resolve the holder worktree's filesystem path from its id, verifying the id
 *  actually belongs to this repo (guards against crafted `repoId::/x` ids). */
export function worktreePathFromId(repoId: string, worktreeId: string): string | null {
  const parsed = splitWorktreeId(worktreeId)
  return parsed && parsed.repoId === repoId ? parsed.worktreePath : null
}

/** Whether a holder path IS the repo root (the sync target). Normalized like
 *  assertWorktreeBelongsToRoot — a raw === would miss a separator/case
 *  difference and let activation detach + reset the root against itself. */
export function isRootHolderPath(worktreePath: string, rootPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(worktreePath) === normalizeRuntimePathForComparison(rootPath)
  )
}

/** Persisted state for a just-completed activation; carries the original
 *  activation timestamp across a takeover so it reads as one continuous session. */
export function activeStateFromActivation(
  repoId: string,
  worktreeId: string,
  outcome: SpotlightActivateOutcome,
  previousActivatedAt: number | undefined
): SpotlightRepoState {
  const now = Date.now()
  return {
    repoId,
    holderWorktreeId: worktreeId,
    status: 'active',
    originalBranch: outcome.originalBranch,
    originalHeadSha: outcome.originalHeadSha,
    backupSha: outcome.backupSha,
    lastSnapshotSha: outcome.snapshotSha,
    activatedAt: previousActivatedAt ?? now,
    lastSyncAt: now,
    lastError: null
  }
}

/** Persisted state after a sync; a skipped no-op keeps the prior sync time. */
export function syncedSpotlightState(
  state: SpotlightRepoState,
  outcome: SpotlightSyncOutcome
): SpotlightRepoState {
  return {
    ...state,
    status: 'active',
    lastSnapshotSha: outcome.snapshotSha,
    lastSyncAt: outcome.skipped ? state.lastSyncAt : Date.now(),
    lastError: null
  }
}

/** Optimistic placeholder shown while the first activation of a repo is in
 *  flight, before the git engine reports real refs. */
export function pendingSpotlightState(
  repoId: string,
  worktreeId: string,
  timestamp: number
): SpotlightRepoState {
  return {
    repoId,
    holderWorktreeId: worktreeId,
    status: 'syncing',
    originalBranch: null,
    originalHeadSha: '',
    backupSha: '',
    lastSnapshotSha: null,
    activatedAt: timestamp,
    lastSyncAt: null,
    lastError: null
  }
}
