import type { PRCheckDetail, PRCheckRunDetails } from '../../../src/shared/github/check-types'
import type { GitHubAssignableUser, PRInfo } from '../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcPayloadMember, rpcReadUnchecked } from '../transport/rpc-reader-payload'
import type { GitHubPrRepoSlug } from './github-pr-repo-slug'
import {
  readAssignableUsers,
  readForBranch,
  readPRCheckDetails,
  readPRChecks,
  readPRForBranchOutcome,
  readWorkItemDetails
} from './github-pr-parsers'

// The PR sidebar's reads. Every one of these replies was re-typed and hand-parsed at the wrapper;
// the readers below are now the only place that says what each payload is. They keep the defensive
// parsers unchanged, so a payload that used to degrade to null still degrades to null.
//
// All seven share one acceptance: a refused read is an error the sidebar shows, never a skip. The
// wrapper turns the throw back into its `{ ok: false, error }` outcome, which is the contract the
// sidebar's loaders route on.

const repoSlugReader: RpcCompatibleReader<unknown, 'pr-repo-slug', GitHubPrRepoSlug | null> = (
  raw
) => {
  if (!raw || typeof raw !== 'object') {
    return rpcReadUnchecked('pr-repo-slug', null)
  }
  const owner = rpcPayloadMember(raw, 'owner')
  const repo = rpcPayloadMember(raw, 'repo')
  const host = rpcPayloadMember(raw, 'host')
  return rpcReadUnchecked(
    'pr-repo-slug',
    typeof owner === 'string' && typeof repo === 'string'
      ? { owner, repo, ...(typeof host === 'string' && host ? { host } : {}) }
      : null
  )
}

/** Whether the worktree's repo has a GitHub remote, which gates the dedicated PR-view icon. */
export const githubPrRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-repo-slug',
    method: 'github.repoSlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: repoSlugReader
  })
)

const hostedReviewInfoReader: RpcCompatibleReader<
  unknown,
  'hosted-review-for-branch',
  HostedReviewInfo | null
> = (raw) => rpcReadUnchecked('hosted-review-for-branch', readForBranch(raw))

export const hostedReviewBranchLookupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.for-branch',
    method: 'hostedReview.forBranch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: hostedReviewInfoReader
  })
)

/** The one reader here that throws rather than degrading, because main's parse did. */
const prForBranchReader: RpcCompatibleReader<unknown, 'pr-for-branch', PRInfo | null> = (raw) =>
  rpcReadUnchecked('pr-for-branch', readPRForBranchOutcome(raw))

export const githubPrForBranchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-for-branch',
    method: 'github.prForBranch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: prForBranchReader
  })
)

const workItemDetailsReader: RpcCompatibleReader<
  unknown,
  'pr-work-item-details',
  GitHubWorkItemDetails | null
> = (raw) => rpcReadUnchecked('pr-work-item-details', readWorkItemDetails(raw))

export const githubPrWorkItemDetailsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-work-item-details',
    method: 'github.workItemDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: workItemDetailsReader
  })
)

const prChecksReader: RpcCompatibleReader<unknown, 'pr-checks', PRCheckDetail[]> = (raw) =>
  rpcReadUnchecked('pr-checks', readPRChecks(raw))

export const githubPrChecksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-checks',
    method: 'github.prChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: prChecksReader
  })
)

const prCheckDetailsReader: RpcCompatibleReader<
  unknown,
  'pr-check-run-details',
  PRCheckRunDetails | null
> = (raw) => rpcReadUnchecked('pr-check-run-details', readPRCheckDetails(raw))

export const githubPrCheckDetailsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-check-details',
    method: 'github.prCheckDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: prCheckDetailsReader
  })
)

const assignableUsersReader: RpcCompatibleReader<
  unknown,
  'pr-assignable-users',
  GitHubAssignableUser[]
> = (raw) => rpcReadUnchecked('pr-assignable-users', readAssignableUsers(raw))

export const githubPrAssignableUsersRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-assignable-users',
    method: 'github.listAssignableUsers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: assignableUsersReader
  })
)
