import {
  MobileWebProviderReviewManagementPayloadSchema,
  MobileWebProviderReviewManagementResultSchema,
  type MobileWebProviderReviewManagementPayload,
  type MobileWebProviderReviewManagementResult
} from '../../../src/shared/mobile-web/provider-review-management-contract'
import type { MobileWebProviderReview } from '../../../src/shared/mobile-web/provider-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { githubProviderReviewTarget } from './mobile-web-provider-review-targets'
import {
  assertCurrentRepositoryIdentity,
  readHostedReviewSummary,
  readProviderDetails
} from './mobile-web-provider-review-state'
import { sanitizeMobileWebProviderReviewDetails } from './mobile-web-provider-review-sanitizer'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'

type MutationAuthority = {
  revalidate: () => Promise<void>
  assertCurrent: () => void
}

export async function executeMobileWebProviderReviewManagement(args: {
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebProviderReviewManagementResult> {
  const payload = MobileWebProviderReviewManagementPayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(args.client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const summary = await readHostedReviewSummary(args.client, repo, payload)
  if (
    !summary ||
    summary.provider !== payload.provider ||
    summary.number !== payload.reviewNumber
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const details = await readProviderDetails(args.client, repo, summary)
  const review = sanitizeMobileWebProviderReviewDetails(summary, details)
  if (review.detailsState !== 'loaded') {
    throw new MobileWebBrokerError('conflict')
  }
  if (review.provider !== 'github') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const authority: MutationAuthority = {
    revalidate: () => assertCurrentRepositoryIdentity(args.client, hostWorkspaceId, payload),
    assertCurrent: () =>
      args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  }
  await executeGitHubManagement(args.client, repo, payload, details, review, authority)
  return MobileWebProviderReviewManagementResultSchema.parse({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    action: payload.action,
    outcome: 'completed'
  })
}

async function executeGitHubManagement(
  client: RpcClient,
  repo: string,
  payload: MobileWebProviderReviewManagementPayload,
  details: unknown,
  review: MobileWebProviderReview,
  authority: MutationAuthority
): Promise<void> {
  const target = githubProviderReviewTarget(details)
  if (payload.action === 'merge') {
    return runAuthorizedMutation(authority, client, 'github.mergePR', {
      repo,
      prNumber: payload.reviewNumber,
      ...(payload.method ? { method: payload.method } : {}),
      ...target
    })
  }
  if (payload.action === 'setAutoMerge') {
    return runAuthorizedMutation(authority, client, 'github.setPRAutoMerge', {
      repo,
      prNumber: payload.reviewNumber,
      enabled: payload.enabled,
      ...(payload.method ? { method: payload.method } : {}),
      ...target
    })
  }
  if (payload.action === 'setState') {
    return runAuthorizedMutation(authority, client, 'github.updatePRState', {
      repo,
      prNumber: payload.reviewNumber,
      updates: { state: payload.state },
      ...target
    })
  }
  if (payload.action === 'requestReviewers' || payload.action === 'removeReviewers') {
    await assertAssignableReviewers(client, repo, payload.reviewers)
    return runAuthorizedMutation(
      authority,
      client,
      payload.action === 'requestReviewers'
        ? 'github.requestPRReviewers'
        : 'github.removePRReviewers',
      { repo, prNumber: payload.reviewNumber, reviewers: payload.reviewers, ...target }
    )
  }
  if (payload.action === 'rerunChecks') {
    if (payload.expectedReviewHead && payload.expectedReviewHead !== review.headSha) {
      throw new MobileWebBrokerError('conflict')
    }
    return runAuthorizedMutation(authority, client, 'github.rerunPRChecks', {
      repo,
      prNumber: payload.reviewNumber,
      ...(review.headSha ? { headSha: review.headSha } : {}),
      ...(payload.failedOnly === undefined ? {} : { failedOnly: payload.failedOnly }),
      ...target
    })
  }
  if (payload.action === 'updateTitle') {
    return runAuthorizedMutation(authority, client, 'github.updatePRTitle', {
      repo,
      prNumber: payload.reviewNumber,
      title: payload.title,
      ...target
    })
  }
  return mutateConversationComment(authority, client, payload, target.prRepo, review)
}

async function mutateConversationComment(
  authority: MutationAuthority,
  client: RpcClient,
  payload: Extract<
    MobileWebProviderReviewManagementPayload,
    { action: 'updateConversationComment' | 'deleteConversationComment' }
  >,
  prRepo: Record<string, string> | undefined,
  review: MobileWebProviderReview
): Promise<void> {
  const comment = review.comments.find(
    (candidate) => candidate.id === payload.commentId && candidate.kind === 'conversation'
  )
  const commentId = positiveIntegerString(payload.commentId)
  if (!comment || commentId === null || !prRepo) {
    throw new MobileWebBrokerError('conflict')
  }
  return runAuthorizedMutation(
    authority,
    client,
    payload.action === 'updateConversationComment'
      ? 'github.project.updateIssueCommentBySlug'
      : 'github.project.deleteIssueCommentBySlug',
    {
      ...prRepo,
      commentId,
      ...(payload.action === 'updateConversationComment' ? { body: payload.body } : {})
    }
  )
}

async function assertAssignableReviewers(
  client: RpcClient,
  repo: string,
  reviewers: string[]
): Promise<void> {
  const response = await client.sendRequest('github.listAssignableUsers', { repo })
  if (!response.ok || !Array.isArray(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  const assignable = new Set(
    response.result.flatMap((value) =>
      isRecord(value) && typeof value.login === 'string' ? [value.login.toLowerCase()] : []
    )
  )
  if (reviewers.some((reviewer) => !assignable.has(reviewer.toLowerCase()))) {
    throw new MobileWebBrokerError('conflict')
  }
}

async function runAuthorizedMutation(
  authority: MutationAuthority,
  client: RpcClient,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  await authority.revalidate()
  authority.assertCurrent()
  return runMutation(client, method, params)
}

async function runMutation(
  client: RpcClient,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const response = await client.sendRequest(method, params)
  if (
    !response.ok ||
    (response.result !== true && (!isRecord(response.result) || response.result.ok !== true))
  ) {
    throw new MobileWebBrokerError('host_error')
  }
}

function positiveIntegerString(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
