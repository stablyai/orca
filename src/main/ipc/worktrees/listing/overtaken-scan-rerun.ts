// Allow overlap recovery, then one further re-scan before bounding continuous churn.
export const SUPERSEDED_SCAN_RESCANS = 2

/** Re-run overtaken scans through the same guards; callers must reject any final superseded rows. */
export async function scanUntilNotOvertaken<T extends { superseded: boolean }>(
  repoId: string,
  scanOnce: () => Promise<T>,
  mayRescan: () => boolean
): Promise<T> {
  let scan = await scanOnce()
  for (let rescans = 0; scan.superseded; rescans += 1) {
    if (rescans >= SUPERSEDED_SCAN_RESCANS) {
      // Bound exhaustion is the host's only evidence of sustained mutation churn.
      console.warn(
        `[worktrees] ${rescans + 1} scans of repo ${repoId} in a row were overtaken by worktree changes; answering without the last one`
      )
      return scan
    }
    if (!mayRescan()) {
      return scan
    }
    scan = await scanOnce()
  }
  return scan
}
