import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import type { MergedWorktreeAutoCloseDecision } from '../../shared/merged-worktree-auto-close'
import { scanMergedWorktreeAutoCloseCandidates } from './merged-worktree-auto-close-scan'

/** Why a cooldown: `worktrees:list` fires on every sidebar refresh, and the sweep shells out to Git per branch. */
export const MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS = 5 * 60 * 1000

/** Structural view of the runtime; `OrcaRuntimeService` satisfies it. */
export type MergedWorktreeAutoCloseRuntime = {
  removeManagedWorktree(
    worktreeSelector: string,
    force?: boolean,
    runHooks?: boolean,
    allowUnverifiedPtyStop?: boolean,
    hostId?: string
  ): Promise<unknown>
}

export type MergedWorktreeAutoCloseResult = {
  closed: string[]
  failed: { worktreeId: string; error: string }[]
  decisions: MergedWorktreeAutoCloseDecision[]
}

export type MergedWorktreeAutoCloseOptions = {
  now?: number
  signal?: AbortSignal
  scan?: typeof scanMergedWorktreeAutoCloseCandidates
}

const lastSweepAtByRepoId = new Map<string, number>()
const sweepsInFlightByRepoId = new Map<string, Promise<MergedWorktreeAutoCloseResult>>()

export function isMergedWorktreeAutoCloseEnabled(store: Store): boolean {
  return store.getSettings().autoCloseMergedWorktrees === true
}

/**
 * Close every workspace in the repo whose branch has landed. Removal goes
 * through the runtime's managed delete, so Orca's own tracking state, PTYs and
 * the now-orphaned branch are cleaned up exactly like a user-initiated delete.
 */
export async function autoCloseMergedWorktreesForRepo(
  store: Store,
  runtime: MergedWorktreeAutoCloseRuntime,
  repo: Repo,
  options: MergedWorktreeAutoCloseOptions = {}
): Promise<MergedWorktreeAutoCloseResult> {
  const scan = options.scan ?? scanMergedWorktreeAutoCloseCandidates
  const decisions = await scan(store, repo, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })
  const closed: string[] = []
  const failed: MergedWorktreeAutoCloseResult['failed'] = []

  for (const decision of decisions) {
    if (decision.action !== 'close') {
      continue
    }
    try {
      // Why never force: Git's own non-force removal is the authoritative refusal
      // for a workspace that turned dirty between the scan and this call.
      await runtime.removeManagedWorktree(`id:${decision.worktreeId}`, false, false, false)
      closed.push(decision.worktreeId)
    } catch (error) {
      failed.push({
        worktreeId: decision.worktreeId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { closed, failed, decisions }
}

/**
 * Run the sweep for a repo unless it is disabled, already running, or ran
 * within the cooldown. Never rejects: callers fire this from lifecycle points
 * whose own result must not depend on it.
 */
export function scheduleMergedWorktreeAutoCloseForRepo(
  store: Store,
  runtime: MergedWorktreeAutoCloseRuntime,
  repo: Repo,
  options: MergedWorktreeAutoCloseOptions = {}
): Promise<MergedWorktreeAutoCloseResult | null> {
  if (!isMergedWorktreeAutoCloseEnabled(store)) {
    return Promise.resolve(null)
  }
  const inFlight = sweepsInFlightByRepoId.get(repo.id)
  if (inFlight) {
    return inFlight.catch(() => null)
  }
  const now = options.now ?? Date.now()
  const lastSweepAt = lastSweepAtByRepoId.get(repo.id)
  if (
    lastSweepAt !== undefined &&
    now - lastSweepAt < MERGED_WORKTREE_AUTO_CLOSE_REPO_COOLDOWN_MS
  ) {
    return Promise.resolve(null)
  }
  lastSweepAtByRepoId.set(repo.id, now)

  const sweep = autoCloseMergedWorktreesForRepo(store, runtime, repo, { ...options, now })
  sweepsInFlightByRepoId.set(repo.id, sweep)
  return sweep
    .catch((error): null => {
      console.warn(`[worktree-auto-close] Sweep failed for repo "${repo.id}"`, error)
      return null
    })
    .finally(() => {
      sweepsInFlightByRepoId.delete(repo.id)
    })
}

export function _resetMergedWorktreeAutoCloseStateForTests(): void {
  lastSweepAtByRepoId.clear()
  sweepsInFlightByRepoId.clear()
}
