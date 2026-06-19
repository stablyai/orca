import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../src/shared/hosted-review'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

// The mobile worktree id is `${repoId}::${path}`; the repo selector the host
// hosted-review RPCs expect is `id:${repoId}`.
export function mobileRepoSelectorFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf('::')
  const repoId = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  return `id:${repoId}`
}

export type MobilePrEligibilityInput = {
  branch: string
  base?: string | null
  hasUncommittedChanges: boolean
  hasUpstream: boolean
  ahead: number
  behind: number
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
}

export async function fetchMobilePrEligibility(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: MobilePrEligibilityInput
): Promise<HostedReviewCreationEligibility | null> {
  const response = await client.sendRequest('hostedReview.getCreationEligibility', {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    worktree: `id:${worktreeId}`,
    branch: input.branch,
    base: input.base ?? null,
    hasUncommittedChanges: input.hasUncommittedChanges,
    hasUpstream: input.hasUpstream,
    ahead: input.ahead,
    behind: input.behind,
    linkedGitHubPR: input.linkedGitHubPR ?? null,
    linkedGitLabMR: input.linkedGitLabMR ?? null
  })
  if (!response.ok) {
    return null
  }
  return (response as RpcSuccess).result as HostedReviewCreationEligibility
}

export type MobilePrPrefill = {
  provider: HostedReviewProvider
  base: string
  title: string
  body: string
}

// Fetches hosted-review eligibility and derives the PR compose prefill from it
// — so non-GitHub repos (e.g. GitLab) get the right provider/base instead of a
// hardcoded one. Falls back to a github/main default (with the branch label as
// title) when branch/eligibility is unavailable.
export async function resolveMobilePrPrefill(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    branch: string | undefined
    title: string
    hasUncommittedChanges: boolean
    hasUpstream: boolean
    ahead: number
    behind: number
  }
): Promise<MobilePrPrefill> {
  const fallback: MobilePrPrefill = {
    provider: 'github',
    base: 'main',
    title: args.title,
    body: ''
  }
  if (!args.branch) {
    return fallback
  }
  try {
    const eligibility = await fetchMobilePrEligibility(client, worktreeId, {
      branch: args.branch,
      hasUncommittedChanges: args.hasUncommittedChanges,
      hasUpstream: args.hasUpstream,
      ahead: args.ahead,
      behind: args.behind
    })
    if (!eligibility) {
      return fallback
    }
    return {
      provider: eligibility.provider,
      base: eligibility.defaultBaseRef || 'main',
      title: eligibility.title || args.title,
      body: eligibility.body || ''
    }
  } catch {
    return fallback
  }
}

export type MobilePrCreateInput = {
  provider: HostedReviewProvider
  base: string
  head?: string
  title: string
  body: string
  draft: boolean
}

// Builds the hostedReview.create params, trimming title/body and dropping empty
// optional fields so the host's required-string validation passes cleanly.
export function buildMobilePrCreateParams(
  worktreeId: string,
  input: MobilePrCreateInput
): Record<string, unknown> {
  return {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    worktree: `id:${worktreeId}`,
    provider: input.provider,
    base: input.base,
    ...(input.head && input.head.length > 0 ? { head: input.head } : {}),
    title: input.title.trim(),
    ...(input.body.trim().length > 0 ? { body: input.body.trim() } : {}),
    draft: input.draft
  }
}

export type MobilePrCreateOutcome =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string }

export async function createMobilePr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: MobilePrCreateInput
): Promise<MobilePrCreateOutcome> {
  try {
    const response = await client.sendRequest(
      'hostedReview.create',
      buildMobilePrCreateParams(worktreeId, input)
    )
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Failed to create pull request' }
    }
    const result = (response as RpcSuccess).result as CreateHostedReviewResult
    if (result.ok) {
      return { ok: true, url: result.url, number: result.number }
    }
    return { ok: false, error: result.error || 'Failed to create pull request' }
  } catch (err) {
    // Why: create-PR runs from an inline form; transport drops should surface as
    // form errors instead of escaping as unhandled promise rejections.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to create pull request'
    }
  }
}
