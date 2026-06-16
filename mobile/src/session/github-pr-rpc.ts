import type {
  GitHubAssignableUser,
  GitHubWorkItemDetails,
  PRCheckDetail,
  PRCheckRunDetails,
  PRInfo
} from '../../../src/shared/types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-pr-create'
import {
  readAssignableUsers,
  readForBranch,
  readPRCheckDetails,
  readPRChecks,
  readPRForBranch,
  readWorkItemDetails
} from './github-pr-parsers'

// Re-export the defensive parsers so consumers (and tests) have a single entry
// point for the github.* PR RPC surface.
export {
  readAssignableUsers,
  readForBranch,
  readPRCheckDetails,
  readPRChecks,
  readPRForBranch,
  readWorkItemDetails
} from './github-pr-parsers'

// Why: a fork PR's head lives in a different owner/repo; the host's SlugRepo
// (`{ owner, repo }`) identifies it. Only a subset of github.* methods accept it.
export type GitHubPrRepoSlug = { owner: string; repo: string }

export type GitHubPrReadOutcome<T> = { ok: true; result: T } | { ok: false; error: string }

// Why: `prRepo` is method-asymmetric (KTD3). These are the only github.* methods
// whose host schema (SlugRepo on PullRequest/PullRequestChecks/PullRequestCheckDetails)
// accepts it; the rest reject the key. Centralizing the allow-list keeps a fork's
// prRepo from leaking into a schema that would reject it.
const METHODS_ACCEPTING_PR_REPO = new Set<string>([
  'github.prChecks',
  'github.prCheckDetails',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.prComments'
])

// Why: only github.prChecks declares a `headSha` param (PullRequestCheckDetails
// does not), so headSha is forwarded just to that read. Check runs are commit-keyed.
const METHODS_ACCEPTING_HEAD_SHA = new Set<string>(['github.prChecks'])

export function buildGithubPrParams(
  method: string,
  worktreeId: string,
  params: Record<string, unknown>,
  options?: { prRepo?: GitHubPrRepoSlug | null; headSha?: string | null }
): Record<string, unknown> {
  const built: Record<string, unknown> = {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    ...params
  }
  if (options?.prRepo && METHODS_ACCEPTING_PR_REPO.has(method) && !('prRepo' in built)) {
    built.prRepo = { owner: options.prRepo.owner, repo: options.prRepo.repo }
  }
  if (options?.headSha && METHODS_ACCEPTING_HEAD_SHA.has(method) && !('headSha' in built)) {
    built.headSha = options.headSha
  }
  return built
}

async function sendGithubPrRead<T>(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: Record<string, unknown>,
  parse: (value: unknown) => T
): Promise<GitHubPrReadOutcome<T>> {
  const response = await client.sendRequest(method, params)
  if (!response.ok) {
    return { ok: false, error: response.error?.message || `Request failed: ${method}` }
  }
  return { ok: true, result: parse((response as RpcSuccess).result) }
}

// Probes whether the worktree's repo has a GitHub remote (a non-null slug). Used
// to decide whether the dedicated PR-view icon is available — independent of
// whether the branch has an open PR.
export async function fetchGithubRepoSlug(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<GitHubPrReadOutcome<GitHubPrRepoSlug | null>> {
  return sendGithubPrRead(
    client,
    'github.repoSlug',
    buildGithubPrParams('github.repoSlug', worktreeId, {}),
    (value) => {
      if (!value || typeof value !== 'object') {
        return null
      }
      const record = value as Record<string, unknown>
      const owner = record.owner
      const repo = record.repo
      return typeof owner === 'string' && typeof repo === 'string' ? { owner, repo } : null
    }
  )
}

export async function fetchHostedReviewForBranch(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { branch: string; linkedGitHubPR?: number | null }
): Promise<GitHubPrReadOutcome<HostedReviewInfo | null>> {
  return sendGithubPrRead(
    client,
    'hostedReview.forBranch',
    {
      repo: mobileRepoSelectorFromWorktreeId(worktreeId),
      branch: args.branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null
    },
    readForBranch
  )
}

export async function fetchPRForBranch(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { branch: string; linkedPRNumber?: number | null }
): Promise<GitHubPrReadOutcome<PRInfo | null>> {
  return sendGithubPrRead(
    client,
    'github.prForBranch',
    buildGithubPrParams('github.prForBranch', worktreeId, {
      branch: args.branch,
      linkedPRNumber: args.linkedPRNumber ?? null
    }),
    readPRForBranch
  )
}

export async function fetchWorkItemDetails(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number }
): Promise<GitHubPrReadOutcome<GitHubWorkItemDetails | null>> {
  return sendGithubPrRead(
    client,
    'github.workItemDetails',
    buildGithubPrParams('github.workItemDetails', worktreeId, {
      number: args.prNumber,
      type: 'pr'
    }),
    readWorkItemDetails
  )
}

export async function fetchPRChecks(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; headSha?: string | null; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrReadOutcome<PRCheckDetail[]>> {
  return sendGithubPrRead(
    client,
    'github.prChecks',
    buildGithubPrParams(
      'github.prChecks',
      worktreeId,
      { prNumber: args.prNumber },
      { prRepo: args.prRepo, headSha: args.headSha }
    ),
    readPRChecks
  )
}

export async function fetchPRCheckDetails(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrReadOutcome<PRCheckRunDetails | null>> {
  const params: Record<string, unknown> = {}
  if (args.checkRunId !== undefined) {
    params.checkRunId = args.checkRunId
  }
  if (args.workflowRunId !== undefined) {
    params.workflowRunId = args.workflowRunId
  }
  if (args.checkName !== undefined) {
    params.checkName = args.checkName
  }
  if (args.url !== undefined) {
    params.url = args.url
  }
  return sendGithubPrRead(
    client,
    'github.prCheckDetails',
    buildGithubPrParams('github.prCheckDetails', worktreeId, params, { prRepo: args.prRepo }),
    readPRCheckDetails
  )
}

export async function fetchAssignableUsers(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<GitHubPrReadOutcome<GitHubAssignableUser[]>> {
  return sendGithubPrRead(
    client,
    'github.listAssignableUsers',
    buildGithubPrParams('github.listAssignableUsers', worktreeId, {}),
    readAssignableUsers
  )
}
