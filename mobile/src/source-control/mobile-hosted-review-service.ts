import type { MobileHostedReviewEligibilityReply } from './hosted-review-reply-schema'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { hostedReviewCopy } from './hosted-review-copy'
import {
  hostedReviewCreateRun,
  hostedReviewEligibilityRead,
  type MobileHostedReviewCreateReply
} from './mobile-hosted-review-operations'
import { pushMobileHostedReviewBranch } from './mobile-hosted-review-git-preparation'
import { linkMobileHostedReview } from './mobile-pr-link'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

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
  client: RpcOperationSender,
  worktreeId: string,
  input: MobileHostedReviewEligibilityInput
): Promise<MobileHostedReviewEligibilityReply | null> {
  const reply = await hostedReviewEligibilityRead.request(client, {
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
  const eligibility = hostedReviewEligibilityRead.interpret(reply)
  return eligibility.accepted ? eligibility.value : null
}

export type MobileHostedReviewPrefill = {
  // The host's own token, echoed back on create. Never narrowed here — see
  // hosted-review-reply-schema.ts.
  provider: string
  base: string
  title: string
  body: string
  canCreate?: boolean
  // Strings, not the shared closed unions: the host publishes tokens those unions do not list, and
  // mobile only compares them to the handful it acts on. See hosted-review-reply-schema.ts.
  blockedReason?: string | null
  nextAction?: string | null
  // Why: mobile lacks the desktop refresh/review-lookup signals, so it fails
  // closed on ambiguity. When the host could not prove the branch has no review
  // (`unavailable`), create — including the Push & Create path — stays blocked.
  reviewLookupOutcome?: string
}

// Resolve the mobile compose prefill from the same hosted-review eligibility
// service desktop uses. If eligibility is unavailable, return a blocked prefill
// instead of inventing a provider/base locally.
export async function resolveMobileHostedReviewPrefill(
  client: RpcOperationSender,
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
      // Eligibility itself could not be resolved: the review lookup is unproven. No `canCreate`,
      // because a false one is a determination — it would route the copy through blockedReason and
      // tell the user the branch is not ready, when what happened is that nobody could say.
      return {
        ...fallback,
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
  provider: string
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
): RpcSendParams<'hostedReview.create'> {
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

const PUSH_BEFORE_CREATE_ERROR = 'Push failed. Resolve the push error, then try again.'

// Why the host's own message is discarded here: the compose form shows one actionable line for
// every push failure, refusal and transport drop alike.
async function pushMobileBranchBeforeCreate(
  client: RpcOperationSender,
  worktreeId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pushed = await pushMobileHostedReviewBranch(
    client,
    { worktree: `id:${worktreeId}` },
    PUSH_BEFORE_CREATE_ERROR
  )
  return pushed.ok ? { ok: true } : { ok: false, error: PUSH_BEFORE_CREATE_ERROR }
}

function formatMobileHostedReviewCreateError(
  result: MobileHostedReviewCreateReply,
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
  client: RpcOperationSender,
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
  client: RpcOperationSender,
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
    const reply = await hostedReviewCreateRun.request(
      client,
      buildMobileHostedReviewCreateParams(worktreeId, input)
    )
    let result: MobileHostedReviewCreateReply
    try {
      result = hostedReviewCreateRun.interpret(reply)
    } catch (error) {
      return {
        ok: false,
        error: refusedRpcMessageOrFallback(error, 'Failed to create pull request')
      }
    }
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
