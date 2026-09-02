import type {
  CreateHostedReviewResult,
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewCreationNextAction,
  HostedReviewLookupOutcome,
  HostedReviewProvider
} from '../../../src/shared/hosted-review'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { hostedReviewCopy } from './hosted-review-copy'
import { linkMobileHostedReview } from './mobile-pr-link'

// The mobile worktree id is `${repoId}::${path}`; hosted-review RPCs expect the
// repo selector separately, matching the desktop/runtime hosted-review service.
export function mobileRepoSelectorFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf('::')
  const repoId = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  return `id:${repoId}`
}

export type MobileHostedReviewEligibilityInput = {
  branch: string
  base?: string | null
  hasUncommittedChanges?: boolean
  hasUpstream?: boolean
  ahead?: number
  behind?: number
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
}

export async function fetchMobileHostedReviewEligibility(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: MobileHostedReviewEligibilityInput
): Promise<HostedReviewCreationEligibility | null> {
  const response = await client.sendRequest('hostedReview.getCreationEligibility', {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    worktree: `id:${worktreeId}`,
    branch: input.branch,
    base: input.base ?? null,
    ...(input.hasUncommittedChanges !== undefined
      ? { hasUncommittedChanges: input.hasUncommittedChanges }
      : {}),
    ...(input.hasUpstream !== undefined ? { hasUpstream: input.hasUpstream } : {}),
    ...(input.ahead !== undefined ? { ahead: input.ahead } : {}),
    ...(input.behind !== undefined ? { behind: input.behind } : {}),
    linkedGitHubPR: input.linkedGitHubPR ?? null,
    linkedGitLabMR: input.linkedGitLabMR ?? null
  })
  if (!response.ok) {
    return null
  }
  return (response as RpcSuccess).result as HostedReviewCreationEligibility
}

export type MobileHostedReviewPrefill = {
  provider: HostedReviewProvider
  base: string
  title: string
  body: string
  canCreate?: boolean
  blockedReason?: HostedReviewCreationBlockedReason
  nextAction?: HostedReviewCreationNextAction
  // Why: mobile lacks the desktop refresh/review-lookup signals, so it fails
  // closed on ambiguity. When the host could not prove the branch has no review
  // (`unavailable`), create — including the Push & Create path — stays blocked.
  reviewLookupOutcome?: HostedReviewLookupOutcome
}

// Resolve the mobile compose prefill from the same hosted-review eligibility
// service desktop uses. If eligibility is unavailable, return a blocked prefill
// instead of inventing a provider/base locally.
export async function resolveMobileHostedReviewPrefill(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: {
    branch: string | undefined
    title: string
    hasUncommittedChanges?: boolean
    hasUpstream?: boolean
    ahead?: number
    behind?: number
  }
): Promise<MobileHostedReviewPrefill> {
  const fallback: MobileHostedReviewPrefill = {
    provider: 'github',
    base: 'main',
    title: args.title,
    body: ''
  }
  if (!args.branch) {
    return { ...fallback, canCreate: false, blockedReason: 'detached_head', nextAction: null }
  }
  try {
    const eligibility = await fetchMobileHostedReviewEligibility(client, worktreeId, {
      branch: args.branch,
      hasUncommittedChanges: args.hasUncommittedChanges,
      hasUpstream: args.hasUpstream,
      ahead: args.ahead,
      behind: args.behind
    })
    if (!eligibility) {
      // Eligibility itself could not be resolved: the review lookup is unproven.
      return {
        ...fallback,
        canCreate: false,
        blockedReason: null,
        nextAction: null,
        reviewLookupOutcome: 'unavailable'
      }
    }
    return {
      provider: eligibility.provider,
      base: eligibility.defaultBaseRef || 'main',
      title: eligibility.title || args.title,
      body: eligibility.body || '',
      canCreate: eligibility.canCreate,
      blockedReason: eligibility.blockedReason,
      nextAction: eligibility.nextAction,
      reviewLookupOutcome: eligibility.reviewLookupOutcome
    }
  } catch {
    return {
      ...fallback,
      canCreate: false,
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'unavailable'
    }
  }
}

export function shouldPushBeforeMobileHostedReviewCreate(
  prefill: Pick<MobileHostedReviewPrefill, 'blockedReason'>
): boolean {
  return prefill.blockedReason === 'needs_push'
}

export type MobileHostedReviewCreateInput = {
  provider: HostedReviewProvider
  base: string
  head?: string
  title: string
  body: string
  draft: boolean
  useTemplate?: boolean
  pushBeforeCreate?: boolean
}

// Builds the hostedReview.create params, trimming title/body and dropping empty
// optional fields so the host's required-string validation passes cleanly.
export function buildMobileHostedReviewCreateParams(
  worktreeId: string,
  input: MobileHostedReviewCreateInput
): Record<string, unknown> {
  return {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    worktree: `id:${worktreeId}`,
    provider: input.provider,
    base: input.base.trim(),
    ...(input.head && input.head.trim().length > 0 ? { head: input.head.trim() } : {}),
    title: input.title.trim(),
    ...(input.body.trim().length > 0 ? { body: input.body.trim() } : {}),
    draft: input.draft,
    ...(input.useTemplate !== undefined ? { useTemplate: input.useTemplate } : {})
  }
}

export type MobileHostedReviewCreateOutcome =
  | { ok: true; url: string; number?: number; existing?: boolean; linkError?: string }
  | { ok: false; error: string }

async function pushMobileBranchBeforeCreate(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await client.sendRequest('git.push', { worktree: `id:${worktreeId}` })
    if (!response.ok) {
      return { ok: false, error: 'Push failed. Resolve the push error, then try again.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Push failed. Resolve the push error, then try again.' }
  }
}

function formatMobileHostedReviewCreateError(
  result: CreateHostedReviewResult,
  pushed: boolean,
  shortLabel: string
): string {
  if (result.ok) {
    return ''
  }
  if (!pushed) {
    return result.error
  }
  const prefix = new RegExp(`^Create ${shortLabel} failed:\\s*`, 'i')
  return `Push succeeded, but ${shortLabel} creation failed: ${result.error.replace(prefix, '')}`
}

async function finishMobileHostedReviewCreateSuccess(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: MobileHostedReviewCreateInput,
  result: { number: number; url: string },
  existing?: boolean
): Promise<MobileHostedReviewCreateOutcome> {
  const baseRef = input.base.trim()
  const linked = await linkMobileHostedReview(client, worktreeId, input.provider, result.number, {
    // Why: mobile branch compare cannot infer the new hosted review's target
    // base from renderer cache; persist the submitted base for the refresh.
    baseRef
  })
  return {
    ok: true,
    url: result.url,
    number: result.number,
    ...(existing ? { existing: true } : {}),
    ...(linked.ok ? {} : { linkError: linked.error })
  }
}

export async function createMobileHostedReview(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: MobileHostedReviewCreateInput
): Promise<MobileHostedReviewCreateOutcome> {
  let pushed = false
  try {
    if (input.pushBeforeCreate) {
      const push = await pushMobileBranchBeforeCreate(client, worktreeId)
      if (!push.ok) {
        return push
      }
      pushed = true
    }
    const response = await client.sendRequest(
      'hostedReview.create',
      buildMobileHostedReviewCreateParams(worktreeId, input)
    )
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Failed to create pull request' }
    }
    const result = (response as RpcSuccess).result as CreateHostedReviewResult
    if (result.ok) {
      return finishMobileHostedReviewCreateSuccess(client, worktreeId, input, result)
    }
    if (result.existingReview?.url) {
      const number = result.existingReview.number
      if (!number) {
        return {
          ok: true,
          url: result.existingReview.url,
          existing: true
        }
      }
      return finishMobileHostedReviewCreateSuccess(
        client,
        worktreeId,
        input,
        { number, url: result.existingReview.url },
        true
      )
    }
    return {
      ok: false,
      error:
        formatMobileHostedReviewCreateError(
          result,
          pushed,
          hostedReviewCopy(input.provider).shortLabel
        ) || 'Failed to create pull request'
    }
  } catch (err) {
    // Why: create review runs from an inline form; transport drops should surface
    // as form errors instead of escaping as unhandled promise rejections.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to create pull request'
    }
  }
}
