import {
  buildFixBrokenChecksPrompt,
  collectFixChecksPromptDetails
} from '../../../src/shared/pr-checks-fix-prompt'
import { splitWorktreeIdForFilesystem } from '../../../src/shared/worktree/id'
import { buildResolvePullRequestConflictsPrompt } from '../../../src/shared/source-control-conflict-prompts'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../src/shared/github/check-types'

// Like desktop, the agent gets the failing steps' log tails, not just check names.
export async function buildFixChecksPrompt(input: {
  prNumber: number
  prTitle: string
  prUrl: string
  checks: PRCheckDetail[]
  loadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
}): Promise<string> {
  return buildFixBrokenChecksPrompt({
    reviewNumber: input.prNumber,
    reviewTitle: input.prTitle,
    reviewUrl: input.prUrl,
    checks: input.checks,
    checkRunDetailsByCheckKey: await collectFixChecksPromptDetails(
      input.checks,
      input.loadCheckDetails
    )
  })
}

export function buildResolveConflictsPrompt(input: {
  prNumber: number
  baseRef?: string | null
  files: string[]
  worktreeId: string
}): string {
  return buildResolvePullRequestConflictsPrompt({
    reviewKind: 'PR',
    baseRef: input.baseRef ?? undefined,
    entries: input.files.map((path) => ({ path })),
    worktreePath: splitWorktreeIdForFilesystem(input.worktreeId)?.worktreePath ?? null
  })
}
