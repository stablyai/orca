import type {
  BitbucketConnectArgs,
  BitbucketConnectionStatus
} from '../../shared/bitbucket-credentials'
import type {
  CreateHostedReviewArgs,
  CreateHostedReviewResult,
  CreateStackedHostedReviewArgs,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs,
  HostedReviewInfo
} from '../../shared/hosted-review'

export type HostedReviewApi = {
  forBranch: (args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>
  getCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  create: (args: CreateHostedReviewArgs) => Promise<CreateHostedReviewResult>
  createStacked: (args: CreateStackedHostedReviewArgs) => Promise<CreateStackedHostedReviewResult>
}

export type BitbucketApi = {
  connect: (
    args: BitbucketConnectArgs
  ) => Promise<{ ok: true; account: string | null } | { ok: false; error: string }>
  disconnect: () => Promise<void>
  status: () => Promise<BitbucketConnectionStatus>
}
