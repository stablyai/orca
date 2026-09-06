import {
  MobileWebProviderReviewMutationPayloadSchema,
  MobileWebProviderReviewPayloadSchema,
  MobileWebProviderReviewResultSchema,
  type MobileWebProviderReviewMutationResult,
  type MobileWebProviderReviewResult
} from '../../../src/shared/mobile-web/provider-review-contract'
import type { MobileWebProviderReviewSubmissionResult } from '../../../src/shared/mobile-web/provider-review-submission-contract'
import type { MobileWebProviderReviewManagementResult } from '../../../src/shared/mobile-web/provider-review-management-contract'
import type { MobileWebProviderReviewQueryResult } from '../../../src/shared/mobile-web/provider-review-query-contract'
import type {
  MobileWebProviderReviewCreateResult,
  MobileWebProviderReviewEligibilityResult,
  MobileWebProviderReviewFieldsResult
} from '../../../src/shared/mobile-web/provider-review-creation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebProviderReviewMutation } from './mobile-web-provider-review-mutations'
import { executeMobileWebProviderReviewManagement } from './mobile-web-provider-review-management'
import { executeMobileWebProviderReviewQuery } from './mobile-web-provider-review-query'
import {
  createMobileWebProviderReview,
  generateMobileWebProviderReviewFields,
  readMobileWebProviderReviewEligibility
} from './mobile-web-provider-review-creation'
import { executeMobileWebProviderReviewSubmission } from './mobile-web-provider-review-submission'
import { sanitizeMobileWebProviderReviewDetails } from './mobile-web-provider-review-sanitizer'
import {
  assertCurrentRepositoryIdentity,
  readHostedReviewSummary,
  readProviderDetails
} from './mobile-web-provider-review-state'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebProviderOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<
  | MobileWebProviderReviewResult
  | MobileWebProviderReviewMutationResult
  | MobileWebProviderReviewManagementResult
  | MobileWebProviderReviewQueryResult
  | MobileWebProviderReviewEligibilityResult
  | MobileWebProviderReviewCreateResult
  | MobileWebProviderReviewFieldsResult
  | MobileWebProviderReviewSubmissionResult
> {
  if (args.operation === 'reviewCreationEligibility') {
    return readMobileWebProviderReviewEligibility({
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'reviewCreate') {
    return createMobileWebProviderReview({
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'reviewGenerateFields') {
    return generateMobileWebProviderReviewFields({
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'review') {
    return readProviderReview(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'mutateReview') {
    return mutateProviderReview(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'manageReview') {
    return executeMobileWebProviderReviewManagement({
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'reviewQuery') {
    return executeMobileWebProviderReviewQuery({
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (args.operation === 'submitReview') {
    return executeMobileWebProviderReviewSubmission(
      args.payload,
      args.client,
      args.workspaceAuthority
    )
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function readProviderReview(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebProviderReviewResult> {
  const payload = MobileWebProviderReviewPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const summary = await readHostedReviewSummary(client, repo, payload)
  if (!summary) {
    return MobileWebProviderReviewResultSchema.parse({
      workspaceId: payload.workspaceId,
      observedHead: payload.expectedHead,
      branch: payload.expectedBranch,
      review: null
    })
  }
  const details = await readProviderDetails(client, repo, summary)
  return MobileWebProviderReviewResultSchema.parse({
    workspaceId: payload.workspaceId,
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    review: sanitizeMobileWebProviderReviewDetails(summary, details)
  })
}

async function mutateProviderReview(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebProviderReviewMutationResult> {
  const payload = MobileWebProviderReviewMutationPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const review = await readHostedReviewSummary(client, repo, payload)
  if (!review || review.provider !== payload.provider || review.number !== payload.reviewNumber) {
    throw new MobileWebBrokerError('conflict')
  }
  const details = await readProviderDetails(client, repo, review)
  const sanitized = sanitizeMobileWebProviderReviewDetails(review, details)
  if (sanitized.detailsState !== 'loaded') {
    throw new MobileWebBrokerError('conflict')
  }
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  return executeMobileWebProviderReviewMutation({
    client,
    repo,
    payload,
    details,
    review: sanitized
  })
}
