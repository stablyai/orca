import { WSL_GIT_READ_ENVIRONMENT_WAIT_MS } from './wsl-git-read-environment'
import { gitExecFileAsync } from './runner'

export type RetargetDivergenceOptions = {
  wslDistro?: string
  /** The create's own cancellation signal. Without it a cancelled create leaves these probes
   *  running until the budget expires. */
  signal?: AbortSignal
  /** Shortens only the end-to-end budget so a test can observe a real abort; production always
   *  uses the constant. Mirrors `timeoutMsForTest` on the git exec options. */
  budgetMsForTest?: number
}

/** `unknown` is deliberately not folded into `exceeded`: "the bound says no" and "the bound could
 *  not be evaluated" have different causes and different fixes, and only the second one means a
 *  retarget that would have been cheap was skipped. `unknown` covers a blown deadline, a
 *  cancelled create, and an ordinary Git failure alike — it is "no answer", not "slow". */
export type RetargetDivergence = 'within' | 'exceeded' | 'unknown'

/**
 * How far two bases may drift and still be worth retargeting a prepared checkout between.
 *
 * Measured on a 21,715-file repo: a local `main` and its `origin/main` were 5 commits and 74
 * files apart, while an abandoned fork's `main` — same branch name, so the same base family —
 * was 8,173 commits and 21,708 files from `origin/main`, i.e. a whole-tree checkout. A commit
 * count separates those by three orders of magnitude, so it is the cheap proxy for the tree diff
 * the retarget reset would have to write.
 */
export const RETARGET_MAX_COMMIT_DIVERGENCE = 100

/**
 * Headroom for the walk itself, on top of the worst pre-spawn wait.
 *
 * ~3x the slowest walk measured on the 12GB/80k-ref repo (180ms to reject, 57ms to allow), so a
 * cold WSL environment probe cannot eat the whole budget and make the answer `unknown` by
 * construction.
 */
const RETARGET_DIVERGENCE_WALK_HEADROOM_MS = 500

/**
 * End-to-end deadline for the whole check, not per probe.
 *
 * Derived from the WSL read-environment wait rather than picked: `git-exec-file` awaits that probe
 * before a command timeout even exists, so a budget merely equal to it would guarantee `unknown`
 * on the first WSL-routed create of a session and make the WSL numbers meaningless. Deriving it
 * keeps that relationship explicit instead of coincidental.
 *
 * Sized against what it competes with: this exists only to decide whether to skip a ~4.1s p50 cold
 * `worktree add`, so when it expires the create pays the budget and then does that add anyway. The
 * total stays under that add even on Windows, where a killed probe also awaits `taskkill /t`.
 *
 * It must be a signal, not just a per-command timeout, because a per-command timeout starts only
 * after `git-exec-file` has awaited admission and the WSL read-environment probe, and because the
 * counts and `merge-base` are staged — two per-probe budgets in sequence would be twice the number
 * written here.
 */
export const RETARGET_DIVERGENCE_BUDGET_MS =
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS + RETARGET_DIVERGENCE_WALK_HEADROOM_MS

function probeOptions(
  repoPath: string,
  options: RetargetDivergenceOptions,
  signal: AbortSignal
): { cwd: string; wslDistro?: string; signal: AbortSignal; timeout: number } {
  // Built field by field rather than spread: the caller's bag carries a test-only key that must
  // never reach git's exec options.
  // Both bounds: the signal covers the pre-spawn waits (admission queue, WSL environment) that a
  // command timeout cannot see, and the timeout keeps the bounded tree-kill path for a hung spawn.
  return {
    cwd: repoPath,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    signal,
    timeout: RETARGET_DIVERGENCE_BUDGET_MS
  }
}

/** Commits reachable from `toRef` but not `fromRef`, capped; null when the probe was unusable. */
async function countCommitsAhead(
  repoPath: string,
  fromRef: string,
  toRef: string,
  options: RetargetDivergenceOptions,
  signal: AbortSignal
): Promise<number | null> {
  try {
    // `--max-count` stops the walk, so an unrelated history costs a bounded number of commits
    // rather than a full traversal. Both flags predate the Git 2.25 baseline.
    // `--end-of-options` (Git 2.24) because a range whose left side began with `-` would
    // otherwise parse as an option; callers only pass `refs/`-qualified names today, and this
    // keeps that from being load-bearing.
    const { stdout } = await gitExecFileAsync(
      [
        'rev-list',
        '--count',
        `--max-count=${RETARGET_MAX_COMMIT_DIVERGENCE + 1}`,
        '--end-of-options',
        `${fromRef}..${toRef}`
      ],
      probeOptions(repoPath, options, signal)
    )
    const count = Number.parseInt(stdout.trim(), 10)
    return Number.isNaN(count) ? null : count
  } catch {
    return null
  }
}

/** True/false when Git decided, null when the probe was unusable. */
async function hasCommonHistory(
  repoPath: string,
  leftRef: string,
  rightRef: string,
  options: RetargetDivergenceOptions,
  signal: AbortSignal
): Promise<boolean | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['merge-base', '--end-of-options', leftRef, rightRef],
      probeOptions(repoPath, options, signal)
    )
    return stdout.trim().length > 0
  } catch (error) {
    // Exit 1 is `merge-base` reporting no common ancestor, which is an answer. A timeout or abort
    // carries no exit code and must not be read as one.
    return (error as { code?: unknown }).code === 1 ? false : null
  }
}

/**
 * Whether retargeting a checkout prepared at `preparedBase` onto `targetBase` stays cheap.
 *
 * Fails closed on error, slowness, and cancellation alike: only a positive `within` authorizes
 * reusing the checkout, so every other outcome lands on the cold create path.
 */
export async function measureRetargetDivergence(
  repoPath: string,
  preparedBase: string,
  targetBase: string,
  options: RetargetDivergenceOptions = {}
): Promise<RetargetDivergence> {
  const budget = AbortSignal.timeout(options.budgetMsForTest ?? RETARGET_DIVERGENCE_BUDGET_MS)
  // Combined so cancelling the create stops the probes immediately rather than at the deadline.
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget
  // Both directions: commits the target adds decide what the reset writes, commits only the
  // preparation has decide what it must delete.
  const [ahead, behind] = await Promise.all([
    countCommitsAhead(repoPath, preparedBase, targetBase, options, signal),
    countCommitsAhead(repoPath, targetBase, preparedBase, options, signal)
  ])
  if (ahead === null || behind === null) {
    return 'unknown'
  }
  if (ahead + behind > RETARGET_MAX_COMMIT_DIVERGENCE) {
    return 'exceeded'
  }
  // Only now: `merge-base` has no `--max-count`, so on unrelated histories it would walk both of
  // them in full. Reaching here already proved neither side is more than the cap ahead of the
  // other, which bounds that walk — and unrelated histories of any size fail the counts first.
  // Required because unrelated histories replace the whole tree however few commits they carry.
  const shareHistory = await hasCommonHistory(repoPath, preparedBase, targetBase, options, signal)
  if (shareHistory === null) {
    return 'unknown'
  }
  return shareHistory ? 'within' : 'exceeded'
}
