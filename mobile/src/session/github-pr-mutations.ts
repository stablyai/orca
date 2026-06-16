import type { GitHubPRMergeMethod } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import { buildGithubPrParams, type GitHubPrRepoSlug } from './github-pr-rpc'

// Mutation wrappers for the github.* PR surface, split out so github-pr-rpc.ts
// stays under the max-lines budget. They mirror the read wrappers' shape but
// return a host-status outcome (the host mutations all return
// `{ ok: true } | { ok: false; error: string }`).

export type GitHubPrMutationOutcome = { ok: true } | { ok: false; error: string }

// The host returns the success/failure shape inside `result`; a transport-level
// `response.ok === false` (timeout/connection) is also a failure. Both collapse
// into one outcome the action hook classifies via classifyPrSidebarFailure.
async function sendGithubPrMutation(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: Record<string, unknown>
): Promise<GitHubPrMutationOutcome> {
  const response = await client.sendRequest(method, params)
  if (!response.ok) {
    return { ok: false, error: response.error?.message || `Request failed: ${method}` }
  }
  const result = response.result
  if (result && typeof result === 'object' && 'ok' in result) {
    const r = result as { ok: boolean; error?: unknown }
    if (r.ok === true) {
      return { ok: true }
    }
    return { ok: false, error: typeof r.error === 'string' ? r.error : `Request failed: ${method}` }
  }
  // No structured status (host returned void/undefined) — treat as success.
  return { ok: true }
}

export async function fetchMergePR(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; method?: GitHubPRMergeMethod; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber }
  if (args.method) {
    params.method = args.method
  }
  return sendGithubPrMutation(
    client,
    'github.mergePR',
    buildGithubPrParams('github.mergePR', worktreeId, params, { prRepo: args.prRepo })
  )
}

export async function fetchSetPRAutoMerge(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    prNumber: number
    enabled: boolean
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber, enabled: args.enabled }
  if (args.method) {
    params.method = args.method
  }
  return sendGithubPrMutation(
    client,
    'github.setPRAutoMerge',
    buildGithubPrParams('github.setPRAutoMerge', worktreeId, params, { prRepo: args.prRepo })
  )
}

export async function fetchUpdatePRState(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; state: 'open' | 'closed' }
): Promise<GitHubPrMutationOutcome> {
  // updatePRState does NOT accept prRepo (KTD3) — buildGithubPrParams omits it.
  return sendGithubPrMutation(
    client,
    'github.updatePRState',
    buildGithubPrParams('github.updatePRState', worktreeId, {
      prNumber: args.prNumber,
      updates: { state: args.state }
    })
  )
}

export async function fetchRequestPRReviewers(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[] }
): Promise<GitHubPrMutationOutcome> {
  // requestPRReviewers does NOT accept prRepo (KTD3).
  return sendGithubPrMutation(
    client,
    'github.requestPRReviewers',
    buildGithubPrParams('github.requestPRReviewers', worktreeId, {
      prNumber: args.prNumber,
      reviewers: args.reviewers
    })
  )
}

export async function fetchRemovePRReviewers(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[] }
): Promise<GitHubPrMutationOutcome> {
  // removePRReviewers does NOT accept prRepo (KTD3).
  return sendGithubPrMutation(
    client,
    'github.removePRReviewers',
    buildGithubPrParams('github.removePRReviewers', worktreeId, {
      prNumber: args.prNumber,
      reviewers: args.reviewers
    })
  )
}

export async function fetchRerunPRChecks(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; headSha?: string | null; failedOnly?: boolean }
): Promise<GitHubPrMutationOutcome> {
  // rerunPRChecks does NOT accept prRepo (KTD3); headSha is a plain param here.
  const params: Record<string, unknown> = { prNumber: args.prNumber }
  if (args.failedOnly !== undefined) {
    params.failedOnly = args.failedOnly
  }
  if (args.headSha) {
    params.headSha = args.headSha
  }
  return sendGithubPrMutation(
    client,
    'github.rerunPRChecks',
    buildGithubPrParams('github.rerunPRChecks', worktreeId, params)
  )
}
