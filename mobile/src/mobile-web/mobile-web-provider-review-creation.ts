import {
  MobileWebProviderReviewCreatePayloadSchema,
  MobileWebProviderReviewCreateResultSchema,
  MobileWebProviderReviewEligibilityPayloadSchema,
  MobileWebProviderReviewEligibilityResultSchema,
  MobileWebProviderReviewFieldsPayloadSchema,
  MobileWebProviderReviewFieldsResultSchema,
  type MobileWebProviderReviewCreateResult,
  type MobileWebProviderReviewEligibilityResult,
  type MobileWebProviderReviewFieldsResult
} from '../../../src/shared/mobile-web/provider-review-creation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { readMobileWebSourceControlRepositoryState } from './mobile-web-source-control-repository-state'
import { assertMobileWebRepositoryIdentity } from './mobile-web-source-control-sync-preflight'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function readMobileWebProviderReviewEligibility(args: {
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebProviderReviewEligibilityResult> {
  const payload = MobileWebProviderReviewEligibilityPayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const snapshot = await creationSnapshot(args.client, payload.workspaceId, hostWorkspaceId)
  assertMobileWebRepositoryIdentity(snapshot.repository, payload)
  const response = await args.client.sendRequest('hostedReview.getCreationEligibility', {
    repo: mobileRepoSelectorFromWorktreeId(hostWorkspaceId),
    worktree: `id:${hostWorkspaceId}`,
    branch: payload.expectedBranch,
    base: payload.base ?? null,
    hasUncommittedChanges: snapshot.hasUncommittedChanges,
    hasUpstream: snapshot.repository.upstream.hasUpstream,
    ahead: snapshot.repository.upstream.ahead,
    behind: snapshot.repository.upstream.behind,
    ...snapshot.links
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebProviderReviewEligibilityResultSchema.parse({
    workspaceId: payload.workspaceId,
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    ...boundedEligibility(response.result)
  })
}

export async function createMobileWebProviderReview(args: {
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebProviderReviewCreateResult> {
  const payload = MobileWebProviderReviewCreatePayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const eligibility = await readMobileWebProviderReviewEligibility({
    payload: {
      workspaceId: payload.workspaceId,
      expectedHead: payload.expectedHead,
      expectedBranch: payload.expectedBranch,
      base: payload.base
    },
    client: args.client,
    workspaceAuthority: args.workspaceAuthority
  })
  if (
    !eligibility.canCreate ||
    eligibility.reviewLookupOutcome !== 'not_found' ||
    eligibility.provider !== payload.provider
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const repository = await readMobileWebSourceControlRepositoryState(
    args.client,
    payload.workspaceId,
    hostWorkspaceId
  )
  assertMobileWebRepositoryIdentity(repository, payload)
  args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const response = await args.client.sendRequest('hostedReview.create', {
    repo: mobileRepoSelectorFromWorktreeId(hostWorkspaceId),
    worktree: `id:${hostWorkspaceId}`,
    provider: payload.provider,
    base: payload.base,
    ...(payload.head ? { head: payload.head } : {}),
    title: payload.title,
    ...(payload.body ? { body: payload.body } : {}),
    draft: payload.draft,
    ...(payload.useTemplate === undefined ? {} : { useTemplate: payload.useTemplate })
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebProviderReviewCreateResultSchema.parse({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    ...boundedCreateResult(response.result)
  })
}

export async function generateMobileWebProviderReviewFields(args: {
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebProviderReviewFieldsResult> {
  const payload = MobileWebProviderReviewFieldsPayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const repository = await readMobileWebSourceControlRepositoryState(
    args.client,
    payload.workspaceId,
    hostWorkspaceId
  )
  assertMobileWebRepositoryIdentity(repository, payload)
  args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const response = await args.client.sendRequest('git.generatePullRequestFields', {
    worktree: `id:${hostWorkspaceId}`,
    base: payload.base,
    title: payload.title,
    body: payload.body,
    draft: payload.draft
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  const result = response.result
  return MobileWebProviderReviewFieldsResultSchema.parse(
    result.success === true && isRecord(result.fields)
      ? {
          workspaceId: payload.workspaceId,
          success: true,
          fields: {
            base: result.fields.base,
            title: boundedText(result.fields.title, 512),
            body: boundedText(result.fields.body, 32 * 1024),
            draft: result.fields.draft === true
          }
        }
      : {
          workspaceId: payload.workspaceId,
          success: false,
          error: boundedText(result.error, 1024)
        }
  )
}

async function creationSnapshot(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string
) {
  const [repository, status, worktree] = await Promise.all([
    readMobileWebSourceControlRepositoryState(client, pageWorkspaceId, hostWorkspaceId),
    client.sendRequest('git.status', { worktree: `id:${hostWorkspaceId}` }),
    client.sendRequest('worktree.show', { worktree: `id:${hostWorkspaceId}` })
  ])
  if (
    !status.ok ||
    !isRecord(status.result) ||
    !Array.isArray(status.result.entries) ||
    !worktree.ok ||
    !isRecord(worktree.result) ||
    !isRecord(worktree.result.worktree)
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return {
    repository,
    hasUncommittedChanges: status.result.entries.length > 0,
    links: {
      linkedGitHubPR: positiveInteger(worktree.result.worktree.linkedPR),
      linkedGitLabMR: positiveInteger(worktree.result.worktree.linkedGitLabMR),
      linkedBitbucketPR: positiveInteger(worktree.result.worktree.linkedBitbucketPR),
      linkedAzureDevOpsPR: positiveInteger(worktree.result.worktree.linkedAzureDevOpsPR),
      linkedGiteaPR: positiveInteger(worktree.result.worktree.linkedGiteaPR)
    }
  }
}

function boundedEligibility(value: Record<string, unknown>) {
  return {
    provider: value.provider,
    review: boundedReviewSummary(value.review),
    canCreate: value.canCreate === true,
    blockedReason: value.blockedReason ?? null,
    nextAction: value.nextAction ?? null,
    reviewLookupOutcome: value.reviewLookupOutcome,
    ...(value.defaultBaseRef === undefined
      ? {}
      : { defaultBaseRef: boundedNullableText(value.defaultBaseRef, 512) }),
    ...(value.head === undefined ? {} : { head: boundedNullableText(value.head, 512) }),
    ...(value.title === undefined ? {} : { title: boundedNullableText(value.title, 512) }),
    ...(value.body === undefined ? {} : { body: boundedNullableText(value.body, 32 * 1024) })
  }
}

function boundedCreateResult(value: Record<string, unknown>) {
  if (value.ok === true) {
    return {
      ok: true,
      number: value.number,
      url: value.url
    }
  }
  return {
    ok: false,
    code: value.code,
    error: boundedText(value.error, 1024),
    ...(isRecord(value.existingReview)
      ? { existingReview: boundedReviewSummary(value.existingReview) }
      : {})
  }
}

function boundedReviewSummary(value: unknown) {
  if (!isRecord(value)) {
    return null
  }
  return {
    ...(positiveInteger(value.number) ? { number: positiveInteger(value.number) } : {}),
    url: value.url
  }
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function boundedNullableText(value: unknown, limit: number): string | null {
  return value === null ? null : boundedText(value, limit)
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
