import { defineMethod, type RpcMethod } from '../core'
import {
  HostedReviewCreate,
  HostedReviewCreationEligibility,
  HostedReviewForBranch
} from '../../../../shared/rpc-contract/hosted-review-params'

export const HOSTED_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'hostedReview.forBranch',
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
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.create',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) =>
      runtime.createHostedReview({
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
  }),
  defineMethod({
    name: 'hostedReview.createStacked',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) =>
      runtime.createStackedHostedReview({
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
  })
]
