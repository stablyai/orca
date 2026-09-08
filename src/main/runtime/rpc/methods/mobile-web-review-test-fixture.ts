import type { GitHubWorkItemDetails } from '../../../../shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { RpcContext } from '../core'
import { MOBILE_WEB_REVIEW_METHODS } from './mobile-web-review-methods'

export const REVIEW_WORKTREE = 'id:repo-1::/private/workspace'
export const REVIEW_HEAD = 'b'.repeat(40)
export const REVIEW_BASE = 'a'.repeat(40)
export const REVIEW_BRANCH = 'feature/review'
export const REVIEW_IDENTITY = { expectedHead: REVIEW_HEAD, expectedBranch: REVIEW_BRANCH }

export type ReviewRuntimeCall = { method: string; args: unknown[] }

/** A runtime with only the commands a review wrapper reaches. Anything else it calls is absent, so
 *  an unexpected command fails the test instead of silently answering undefined. */
export function reviewRuntime(commands: Record<string, unknown>): {
  context: RpcContext
  calls: ReviewRuntimeCall[]
} {
  const calls: ReviewRuntimeCall[] = []
  const runtime: Record<string, unknown> = {}
  for (const [method, response] of Object.entries(commands)) {
    runtime[method] = async (...args: unknown[]) => {
      calls.push({ method, args })
      return typeof response === 'function' ? (response as () => unknown)() : response
    }
  }
  return {
    calls,
    context: { runtime, signal: new AbortController().signal } as unknown as RpcContext
  }
}

export function runReviewMethod(
  name: string,
  params: Record<string, unknown>,
  context: RpcContext
): Promise<unknown> {
  const method = MOBILE_WEB_REVIEW_METHODS.find((entry) => entry.name === name)
  if (!method) {
    throw new Error(`Unknown review method: ${name}`)
  }
  return Promise.resolve(
    method.handler(method.params!.parse({ worktree: REVIEW_WORKTREE, ...params }), context)
  )
}

export function reviewStatus(overrides: Record<string, unknown> = {}) {
  return { head: REVIEW_HEAD, branch: REVIEW_BRANCH, entries: [], ...overrides }
}

export function hostedReviewSummary(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 42,
    title: 'Add the review lane',
    state: 'open',
    url: 'https://github.example/acme/orca/pull/42',
    status: 'success',
    updatedAt: '2026-09-07T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    headSha: REVIEW_HEAD,
    ...overrides
  }
}

export function gitHubReviewDetails(
  overrides: Partial<GitHubWorkItemDetails> = {}
): GitHubWorkItemDetails {
  return {
    item: {
      id: 'PR_42',
      number: 42,
      type: 'pr',
      title: 'Add the review lane',
      state: 'open',
      url: 'https://github.example/acme/orca/pull/42',
      labels: [],
      updatedAt: '2026-09-07T00:00:00.000Z',
      author: 'ada',
      prRepo: { owner: 'acme', repo: 'orca', host: 'github.example' },
      reviewRequests: [{ login: 'grace', name: null, avatarUrl: '' }],
      latestReviews: [],
      ...overrides.item
    },
    body: 'Review body',
    headSha: REVIEW_HEAD,
    baseSha: REVIEW_BASE,
    comments: [],
    files: [],
    checks: [],
    ...overrides
  }
}

export function gitLabReviewDetails(overrides: Record<string, unknown> = {}) {
  return {
    item: {
      id: 'MR_42',
      number: 42,
      type: 'mr' as const,
      title: 'Add the review lane',
      state: 'opened' as const,
      url: 'https://gitlab.example/acme/orca/-/merge_requests/42',
      labels: [],
      updatedAt: '2026-09-07T00:00:00.000Z',
      author: 'ada',
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    },
    body: 'Review body',
    headSha: REVIEW_HEAD,
    baseSha: REVIEW_BASE,
    startSha: REVIEW_BASE,
    comments: [],
    files: [],
    ...overrides
  }
}
