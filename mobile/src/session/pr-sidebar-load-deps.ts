import type { RpcClient } from '../transport/rpc-client'
import {
  fetchHostedReviewForBranch,
  fetchPRChecks,
  fetchPRForBranch,
  fetchWorkItemDetails
} from './github-pr-rpc'
import type { PrSidebarLoadDeps } from './mobile-pr-sidebar-state'
import {
  clearMobileWorktreeReviewLink,
  fetchWorktreeGitHubPRLink
} from '../source-control/mobile-pr-link'

// The PR sidebar's reads over one host connection.
export function buildPrSidebarLoadDeps(client: RpcClient): PrSidebarLoadDeps {
  return {
    fetchForBranch: (wt, args) => fetchHostedReviewForBranch(client, wt, args),
    fetchWorktreeGitHubPRLink: (wt) => fetchWorktreeGitHubPRLink(client, wt),
    clearWorktreeReviewLink: (wt, shouldApply) =>
      clearMobileWorktreeReviewLink(client, wt, shouldApply),
    fetchPRForBranch: (wt, args) => fetchPRForBranch(client, wt, args),
    fetchWorkItemDetails: (wt, args) => fetchWorkItemDetails(client, wt, args),
    fetchPRChecks: (wt, args) => fetchPRChecks(client, wt, args)
  }
}
