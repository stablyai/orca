import type { MobileGitStatusEntry } from './mobile-git-status'

export {
  COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  buildFixCommitFailurePrompt,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from '../../../src/shared/source-control-commit-failure'

export type MobileCommitFailureRecovery = {
  error: string
  commitMessage: string
  stagedEntries: Pick<MobileGitStatusEntry, 'path' | 'status' | 'area'>[]
}

export type RecordMobileCommitFailure = (failure: MobileCommitFailureRecovery | null) => void

export function getMobileCommitFailureStagedEntries(
  entries: readonly MobileGitStatusEntry[] | undefined
): Pick<MobileGitStatusEntry, 'path' | 'status' | 'area'>[] {
  return (entries ?? [])
    .filter((entry) => entry.area === 'staged')
    .map((entry) => ({ path: entry.path, status: entry.status, area: entry.area }))
}
