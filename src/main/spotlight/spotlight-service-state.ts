import type { Repo } from '../../shared/types'
import type { SpotlightError, SpotlightRepoState } from '../../shared/spotlight'
import type { SpotlightGitContext } from '../../shared/spotlight-sync-core'
import { splitWorktreeId } from '../../shared/worktree-id'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { SpotlightCoreError } from '../../shared/spotlight-sync-core'
import { isFolderRepo } from '../../shared/repo-kind'
import { createLocalSpotlightGitContext } from '../git/spotlight-sync'
import type { Store } from '../persistence'

export type ResolvedRepoContext =
  | { repo: Repo; ctx: SpotlightGitContext }
  | { error: SpotlightError }

/** Enforce Spotlight eligibility in MAIN, not just the UI: activate/sync run
 *  `checkout --detach` + `reset --hard` on the root, so a renderer bug or
 *  crafted IPC must not rewrite the root of a repo that never opted in, a
 *  folder project, or a remote repo. Mirrors the renderer's canHoldSpotlight.
 *
 *  `requireEnabled: false` skips only the opt-in-flag check — used by deactivate
 *  so the root can always be RESTORED even after the user turns the toggle off
 *  while Spotlight is live (the flag is off but the root is still mirrored). The
 *  folder/host checks stay, since those govern whether a local git context even
 *  exists. */
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

/** Reduce any ref form (refs/heads/x, refs/remotes/origin/x, origin/x) to the
 *  bare local branch name so a configured base ref and the checked-out branch
 *  compare on equal terms. */
function toShortBranchName(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^origin\//, '')
}

/** The repo's primary branch (short name): the base Orca forks worktrees from
 *  (chosen at project creation via worktreeBaseRef), else the detected default
 *  branch (origin/HEAD, then the main/master/develop probes). Null when it can't
 *  be determined, in which case the caller must not gate on it. */
export async function resolvePrimaryBranch(
  ctx: SpotlightGitContext,
  repo: Repo,
  rootPath: string
): Promise<string | null> {
  const configured = repo.worktreeBaseRef?.trim()
  const raw = configured || (await resolveDefaultBaseRefViaExec((argv) => ctx.git(argv, rootPath)))
  return raw ? toShortBranchName(raw) : null
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
