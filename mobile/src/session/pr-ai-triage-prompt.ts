import {
  buildFixBrokenChecksPrompt,
  collectFixChecksPromptDetails,
  hasGitHubCheckHandle
} from '../../../src/shared/pr-checks-fix-prompt'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../transport/rpc-client'
import { fetchPRCheckDetails } from './github-pr-rpc'
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

// The PR's failing checks with their log tails, read from the host one check at a time.
export function buildPrFixChecksPrompt(input: {
  client: RpcClient | null
  worktreeId: string
  pr: PRInfo
  checks: PRCheckDetail[]
}): Promise<string> {
  const { client, worktreeId, pr } = input
  return buildFixChecksPrompt({
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    checks: input.checks,
    loadCheckDetails: async (check) => {
      if (!client || !hasGitHubCheckHandle(check)) {
        return null
      }
      const outcome = await fetchPRCheckDetails(client, worktreeId, {
        checkRunId: check.checkRunId,
        workflowRunId: check.workflowRunId,
        checkName: check.name,
        url: check.url,
        prRepo: pr.prRepo ?? null
      })
      return outcome.ok ? outcome.result : null
    }
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
