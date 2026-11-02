import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
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
  HostedReviewForBranchReply,
  HostedReviewInfo
} from '../../shared/hosted-review'

export type HostedReviewApi = {
  forBranch: {
    (
      args: HostedReviewForBranchArgs & { reportReadOutcome?: false }
    ): Promise<HostedReviewInfo | null>
    (args: HostedReviewForBranchArgs): Promise<HostedReviewForBranchReply>
  }
  getCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  create: (args: CreateHostedReviewArgs) => Promise<CreateHostedReviewResult>
  createStacked: (args: CreateStackedHostedReviewArgs) => Promise<CreateStackedHostedReviewResult>
}

export type BitbucketApi = {
  connect: (args: BitbucketConnectArgs) => Promise<BitbucketConnectResult>
  disconnect: () => Promise<void>
  status: () => Promise<BitbucketConnectionStatus>
}
