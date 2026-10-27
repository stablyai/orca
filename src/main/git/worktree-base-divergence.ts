import { WSL_GIT_READ_ENVIRONMENT_WAIT_MS } from './wsl-git-read-environment'
import { gitExecFileAsync } from './runner'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import type { GitAdmissionTier } from './command-runner/git-exec-options'

export type RetargetDivergenceOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  /** Cancel probes when their owning create is cancelled. */
  signal?: AbortSignal
  /** Override the end-to-end budget in tests only. */
  budgetMsForTest?: number
}

/** unknown means no answer; exceeded means the commit cap was crossed or the histories are unrelated. */
export type RetargetDivergence = 'within' | 'exceeded' | 'unknown'

// Commit divergence is a cheap proxy for retarget writes; cap it to avoid whole-tree checkout costs.
export const RETARGET_MAX_COMMIT_DIVERGENCE = 100

// Leave measured walk headroom after WSL setup so a cold environment does not consume the entire budget.
const RETARGET_DIVERGENCE_WALK_HEADROOM_MS = 500

/** One signal covers staged probes and pre-spawn waits; size it beyond the WSL environment wait. */
export const RETARGET_DIVERGENCE_BUDGET_MS =
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS + RETARGET_DIVERGENCE_WALK_HEADROOM_MS

function probeOptions(
  repoPath: string,
  options: RetargetDivergenceOptions,
  signal: AbortSignal
): {
  cwd: string
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  signal: AbortSignal
  timeout: number
} {
  // Exclude test-only keys; signals cover pre-spawn waits and command timeouts bound hung children.
  return {
    cwd: repoPath,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
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
    // Bound history walks and reject option-like ranges; both flags support the Git 2.25 baseline.
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

/** Reuse prepared checkouts only on a proven within result; every other outcome uses cold creation. */
export async function measureRetargetDivergence(
  repoPath: string,
  preparedBase: string,
  targetBase: string,
  options: RetargetDivergenceOptions = {}
): Promise<RetargetDivergence> {
  const signal = abortSignalWithTimeout(
    options.signal,
    options.budgetMsForTest ?? RETARGET_DIVERGENCE_BUDGET_MS
  )
  // Count both added and removed commits because either direction can require checkout writes.
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
  // Check ancestry after capped counts: even small unrelated histories can replace the whole tree.
  const shareHistory = await hasCommonHistory(repoPath, preparedBase, targetBase, options, signal)
  if (shareHistory === null) {
    return 'unknown'
  }
  return shareHistory ? 'within' : 'exceeded'
}
