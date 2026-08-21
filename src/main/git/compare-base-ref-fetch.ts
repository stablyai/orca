// Why: PR (GitHub) and MR (GitLab) base resolution both need this exact
// trade-off, and both regressed the same way before; one copy keeps them from
// drifting on the next fix.

type CompareBaseGitExec = (args: string[]) => Promise<{ stdout: string }>

/**
 * Refresh the compare base ref, reporting whether callers may keep it.
 *
 * Why: dropping compareBaseRef on any fetch failure makes worktree create fall
 * back to the base branch — the review head itself for fork reviews — so Source
 * Control diffs the worktree against itself. Keep the base whenever the local
 * ref still resolves; only truly missing/absent refs lose it.
 */
export async function fetchCompareBaseRefWithLocalFallback(options: {
  compareBaseRef: string | undefined
  fetchCompareBaseRef: (compareBaseRef: string) => Promise<void>
  gitExec: CompareBaseGitExec
  /** Log prefix identifying the calling resolver, e.g. `[github:resolvePrStartPoint]`. */
  logLabel: string
  /** Resolver-specific fields (remote, branch, review id) merged into the warning. */
  logContext: Record<string, unknown>
}): Promise<boolean> {
  if (!options.compareBaseRef) {
    return false
  }
  try {
    await options.fetchCompareBaseRef(options.compareBaseRef)
    return true
  } catch (error) {
    const localBaseResolved = await compareBaseRefResolvesLocally(
      options.gitExec,
      options.compareBaseRef
    )
    console.warn(`${options.logLabel} optional compare-base fetch failed`, {
      ...options.logContext,
      localBaseResolved,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error)
    })
    return localBaseResolved
  }
}

async function compareBaseRefResolvesLocally(
  gitExec: CompareBaseGitExec,
  compareBaseRef: string
): Promise<boolean> {
  try {
    const { stdout } = await gitExec(['rev-parse', '--verify', `${compareBaseRef}^{commit}`])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
