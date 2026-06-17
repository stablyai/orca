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

// Edit the hosted-review title. The host returns a bare boolean (true on success),
// which sendGithubPrMutation reads via its "no structured status" success branch
// only when not boolean — so handle the boolean explicitly like resolveReviewThread.
export async function fetchUpdatePRTitle(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; title: string; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = { prNumber: args.prNumber, title: args.title }
  // updatePRTitle accepts prRepo for fork PRs, but it is not in the centralized
  // METHODS_ACCEPTING_PR_REPO read allow-list — pass it explicitly so it reaches the
  // host schema (which declares it optional/nullable).
  if (args.prRepo) {
    params.prRepo = { owner: args.prRepo.owner, repo: args.prRepo.repo }
  }
  const response = await client.sendRequest(
    'github.updatePRTitle',
    buildGithubPrParams('github.updatePRTitle', worktreeId, params)
  )
  if (!response.ok) {
    return { ok: false, error: response.error?.message || 'Request failed: github.updatePRTitle' }
  }
  if (response.result === false) {
    return { ok: false, error: 'Failed to update title.' }
  }
  return { ok: true }
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

// Reply within a review thread. Host returns GitHubCommentResult
// (`{ ok, comment } | { ok:false, error }`), which sendGithubPrMutation reads via
// its `ok in result` branch. We refetch afterward, so the returned comment is unused.
export async function fetchAddPRReviewCommentReply(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    prNumber: number
    commentId: number
    body: string
    threadId?: string
    path?: string
    line?: number
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = {
    prNumber: args.prNumber,
    commentId: args.commentId,
    body: args.body
  }
  if (args.threadId) {
    params.threadId = args.threadId
  }
  if (args.path) {
    params.path = args.path
  }
  if (typeof args.line === 'number') {
    params.line = args.line
  }
  // addPRReviewCommentReply accepts prRepo for fork PRs, but it is not in the
  // centralized METHODS_ACCEPTING_PR_REPO allow-list (read-focused) — pass it
  // explicitly so it reaches the host schema, which declares it optional.
  if (args.prRepo) {
    params.prRepo = { owner: args.prRepo.owner, repo: args.prRepo.repo }
  }
  return sendGithubPrMutation(
    client,
    'github.addPRReviewCommentReply',
    buildGithubPrParams('github.addPRReviewCommentReply', worktreeId, params)
  )
}

// Add a root conversation comment to the PR. Host returns GitHubCommentResult.
export async function fetchAddIssueComment(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; body: string; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const params: Record<string, unknown> = {
    number: args.prNumber,
    body: args.body,
    type: 'pr'
  }
  if (args.prRepo) {
    params.prRepo = { owner: args.prRepo.owner, repo: args.prRepo.repo }
  }
  return sendGithubPrMutation(
    client,
    'github.addIssueComment',
    buildGithubPrParams('github.addIssueComment', worktreeId, params)
  )
}

// Resolve/unresolve a review thread. `resolve` picks the direction (the host runs
// the matching GraphQL mutation). Unlike the comment mutations, the host returns a
// bare boolean, so a falsy result is a failure rather than the "no status" success.
export async function fetchResolveReviewThread(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { threadId: string; resolve: boolean }
): Promise<GitHubPrMutationOutcome> {
  const response = await client.sendRequest(
    'github.resolveReviewThread',
    buildGithubPrParams('github.resolveReviewThread', worktreeId, {
      threadId: args.threadId,
      resolve: args.resolve
    })
  )
  if (!response.ok) {
    return {
      ok: false,
      error: response.error?.message || 'Request failed: github.resolveReviewThread'
    }
  }
  if (response.result === false) {
    return { ok: false, error: 'Failed to update review thread.' }
  }
  return { ok: true }
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
