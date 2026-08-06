import type { GitHubPRMergeMethod } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import { buildGithubPrParams, githubPrRepoSlugParam, type GitHubPrRepoSlug } from './github-pr-rpc'

// Mutation wrappers for the github.* PR surface, split out so github-pr-rpc.ts
// stays under the max-lines budget. They mirror the read wrappers' shape but
// return a host-status outcome (the host mutations all return
// `{ ok: true } | { ok: false; error: string }`).

export type GitHubPrMutationOutcome = { ok: true } | { ok: false; error: string }

// Sends a request whose host result is a bare boolean (not the `{ ok }` envelope),
// normalizing a transport throw into a failure so the raw-boolean callers below
// never see an unhandled rejection.
type RawResult = { ok: true; result: unknown } | { ok: false; error: string }

async function sendRaw(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: Record<string, unknown>
): Promise<RawResult> {
  try {
    const response = await client.sendRequest(method, params)
    if (!response.ok) {
      return { ok: false, error: response.error?.message || `Request failed: ${method}` }
    }
    return { ok: true, result: response.result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `Request failed: ${method}` }
  }
}

// Host failure `error` is either a bare string (github.* PR mutations) or an
// object `{ message }` (github.project.* slug mutations). Read whichever is present
// so the slug edit/delete failures surface a real message, not a generic fallback.
function extractMutationError(error: unknown, method: string): string {
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  return `Request failed: ${method}`
}

// The host returns the success/failure shape inside `result`; a transport-level
// `response.ok === false` (timeout/connection) is also a failure. Both collapse
// into one outcome the action hook classifies via classifyPrSidebarFailure.
async function sendGithubPrMutation(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: Record<string, unknown>
): Promise<GitHubPrMutationOutcome> {
  try {
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
      return { ok: false, error: extractMutationError(r.error, method) }
    }
    // No structured status (host returned void/undefined) — treat as success.
    return { ok: true }
  } catch (err) {
    // Why: a transport drop must not escape as an unhandled rejection — normalize
    // to the `{ ok:false, error }` outcome the action engine routes on.
    return { ok: false, error: err instanceof Error ? err.message : `Request failed: ${method}` }
  }
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
  const response = await sendRaw(
    client,
    'github.updatePRTitle',
    buildGithubPrParams('github.updatePRTitle', worktreeId, params, { prRepo: args.prRepo })
  )
  if (!response.ok) {
    return { ok: false, error: response.error || 'Request failed: github.updatePRTitle' }
  }
  // Why: the host returns a bare `true` on success; a missing/undefined result is
  // not a confirmed success, so require an explicit `=== true` rather than `!== false`.
  if (response.result !== true) {
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
  args: { prNumber: number; state: 'open' | 'closed'; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return sendGithubPrMutation(
    client,
    'github.updatePRState',
    buildGithubPrParams(
      'github.updatePRState',
      worktreeId,
      { prNumber: args.prNumber, updates: { state: args.state } },
      { prRepo: args.prRepo }
    )
  )
}

export async function fetchRequestPRReviewers(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[]; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return sendGithubPrMutation(
    client,
    'github.requestPRReviewers',
    buildGithubPrParams(
      'github.requestPRReviewers',
      worktreeId,
      { prNumber: args.prNumber, reviewers: args.reviewers },
      { prRepo: args.prRepo }
    )
  )
}

export async function fetchRemovePRReviewers(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { prNumber: number; reviewers: string[]; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  return sendGithubPrMutation(
    client,
    'github.removePRReviewers',
    buildGithubPrParams(
      'github.removePRReviewers',
      worktreeId,
      { prNumber: args.prNumber, reviewers: args.reviewers },
      { prRepo: args.prRepo }
    )
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
  return sendGithubPrMutation(
    client,
    'github.addPRReviewCommentReply',
    buildGithubPrParams('github.addPRReviewCommentReply', worktreeId, params, {
      prRepo: args.prRepo
    })
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
  return sendGithubPrMutation(
    client,
    'github.addIssueComment',
    buildGithubPrParams('github.addIssueComment', worktreeId, params, { prRepo: args.prRepo })
  )
}

// Resolve/unresolve a review thread. `resolve` picks the direction (the host runs
// the matching GraphQL mutation). Unlike the comment mutations, the host returns a
// bare boolean, so a falsy result is a failure rather than the "no status" success.
export async function fetchResolveReviewThread(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { threadId: string; resolve: boolean; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrMutationOutcome> {
  const response = await sendRaw(
    client,
    'github.resolveReviewThread',
    buildGithubPrParams(
      'github.resolveReviewThread',
      worktreeId,
      { threadId: args.threadId, resolve: args.resolve },
      { prRepo: args.prRepo }
    )
  )
  if (!response.ok) {
    return {
      ok: false,
      error: response.error || 'Request failed: github.resolveReviewThread'
    }
  }
  // Why: the host returns a bare `true` on success; a missing/undefined result is
  // not a confirmed success, so require an explicit `=== true` rather than `!== false`.
  if (response.result !== true) {
    return { ok: false, error: 'Failed to update review thread.' }
  }
  return { ok: true }
}

// Edit a root conversation (issue) comment. The host RPC is slug-addressed
// (owner/repo/commentId), not worktree-addressed, so the params are passed
// directly rather than via buildGithubPrParams. Host returns the
// GitHubProjectMutationResult `{ ok }` envelope sendGithubPrMutation reads.
export async function fetchUpdateIssueComment(
  client: Pick<RpcClient, 'sendRequest'>,
  args: { owner: string; repo: string; host?: string; commentId: number; body: string }
): Promise<GitHubPrMutationOutcome> {
  return sendGithubPrMutation(client, 'github.project.updateIssueCommentBySlug', {
    ...githubPrRepoSlugParam(args),
    commentId: args.commentId,
    body: args.body
  })
}

// Delete a root conversation (issue) comment. Slug-addressed like the edit wrapper.
export async function fetchDeleteIssueComment(
  client: Pick<RpcClient, 'sendRequest'>,
  args: { owner: string; repo: string; host?: string; commentId: number }
): Promise<GitHubPrMutationOutcome> {
  return sendGithubPrMutation(client, 'github.project.deleteIssueCommentBySlug', {
    ...githubPrRepoSlugParam(args),
    commentId: args.commentId
  })
}

export async function fetchRerunPRChecks(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    prNumber: number
    headSha?: string | null
    failedOnly?: boolean
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrMutationOutcome> {
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
    buildGithubPrParams('github.rerunPRChecks', worktreeId, params, { prRepo: args.prRepo })
  )
}
