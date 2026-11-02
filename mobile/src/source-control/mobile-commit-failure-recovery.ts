import type { MobileGitStatusEntry } from './mobile-git-status'

export {
  COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  buildFixCommitFailurePrompt,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from '../../../src/shared/source-control-commit-failure'

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
      // The filter establishes staged; optional entry.area cannot carry that guarantee.
      .map((entry) => ({ path: entry.path, status: entry.status, area: 'staged' as const }))
  )
}
