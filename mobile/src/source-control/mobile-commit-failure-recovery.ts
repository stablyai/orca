import type { MobileGitStatusEntry } from './mobile-git-status'

export {
  COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  buildFixCommitFailurePrompt,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from '../../../src/shared/source-control-commit-failure'

/** What the fix-commit prompt needs from a staged row. `area` is pinned, not carried. */
export type MobileCommitFailureStagedEntry = Pick<MobileGitStatusEntry, 'path' | 'status'> & {
  area: 'staged'
}

export type MobileCommitFailureRecovery = {
  error: string
  commitMessage: string
  stagedEntries: MobileCommitFailureStagedEntry[]
}

export type RecordMobileCommitFailure = (failure: MobileCommitFailureRecovery | null) => void

export function getMobileCommitFailureStagedEntries(
  entries: readonly MobileGitStatusEntry[] | undefined
): MobileCommitFailureStagedEntry[] {
  return (
    (entries ?? [])
      .filter((entry) => entry.area === 'staged')
      // 'staged' literal, not `entry.area`: the filter above is what makes it one, and the schema's
      // area is optional so an unplaceable row could not be typed through here.
      .map((entry) => ({ path: entry.path, status: entry.status, area: 'staged' as const }))
  )
}
