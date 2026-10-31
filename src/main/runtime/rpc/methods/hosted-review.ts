import { defineMethod } from '../core'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import { UNSUPPORTED_HOSTED_REVIEW_PROVIDER } from '../../../source-control/hosted-review-creation'
import {
  HostedReviewCreate,
  HostedReviewCreationEligibility,
  HostedReviewForBranch
} from '../../../../shared/rpc-contract/hosted-review-params'

export const HOSTED_REVIEW_METHODS = [
  defineMethod({
    name: 'hostedReview.forBranch',
    permission: 'workspace',
    params: HostedReviewForBranch,
    handler: async (params, { runtime }) => {
      const fallbackGitHubPR =
        params.linkedGitHubPR == null ? (params.fallbackGitHubPR ?? null) : null
      return runtime.getHostedReviewForBranch({
        repoSelector: params.repo,
        branch: params.branch,
        ...(params.admissionTier ? { admissionTier: params.admissionTier } : {}),
        currentHeadOid: params.currentHeadOid ?? null,
        ...(params.active === true ? { active: true } : {}),
        ...(params.force === true ? { force: true } : {}),
        ...(params.userRefresh === true ? { userRefresh: true } : {}),
        ...(params.reportReadOutcome === true ? { reportReadOutcome: true } : {}),
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.getCreationEligibility',
    permission: 'workspace',
    params: HostedReviewCreationEligibility,
    handler: async (params, { runtime }) => {
      const fallbackGitHubPR =
        params.linkedGitHubPR == null ? (params.fallbackGitHubPR ?? null) : null
      return runtime.getHostedReviewCreationEligibility({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        branch: params.branch,
        base: params.base ?? null,
        hasUncommittedChanges: params.hasUncommittedChanges,
        hasUpstream: params.hasUpstream,
        ahead: params.ahead,
        behind: params.behind,
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null,
        wakeWslDistro: params.wakeWslDistro
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.create',
    permission: 'workspace',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) => {
      // Refuse an unknown host-issued provider token here; schema rejection would be unreadable to the client.
      if (!supportsHostedReviewCreation(params.provider)) {
        return UNSUPPORTED_HOSTED_REVIEW_PROVIDER
      }
      return runtime.createHostedReview({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        provider: params.provider,
        base: params.base,
        head: params.head,
        title: params.title,
        body: params.body,
        draft: params.draft,
        useTemplate: params.useTemplate
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.createStacked',
    permission: 'workspace',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) => {
      if (!supportsHostedReviewCreation(params.provider)) {
        return UNSUPPORTED_HOSTED_REVIEW_PROVIDER
      }
      return runtime.createStackedHostedReview({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        provider: params.provider,
        base: params.base,
        head: params.head,
        title: params.title,
        body: params.body,
        draft: params.draft,
        useTemplate: params.useTemplate
      })
    }
  })
]
