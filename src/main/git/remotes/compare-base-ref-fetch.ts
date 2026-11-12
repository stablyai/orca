type CompareBaseGitExec = (args: string[]) => Promise<{ stdout: string }>

/** Keep a locally resolvable base after fetch failure; dropping it can make fork reviews diff against themselves. */
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
