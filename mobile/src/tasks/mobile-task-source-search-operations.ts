import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked, rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'
import { extractLinearIssueReadItems } from './linear-mobile-issue-read'

// The Smart workspace-source picker's provider reads: per-repo search, and the single-item lookups
// a pasted link or number resolves to. Provider-specific fallbacks stay at their own call sites.

export const githubWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-search',
    method: 'github.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-work-items')
  })
)

/** GitLab answers in-band too: an accepted reply can carry a provider `error` the caller raises. */
export const gitlabWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-search',
    method: 'gitlab.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-work-items')
  })
)

// Linear replies either as a bare array or as an `{ items }` envelope, and the picker has always
// accepted both through this projection. Two operations share it because the empty-query path asks
// a different method, not because the two answers differ.
const linearIssueReader: RpcCompatibleReader<unknown, 'linear-issues', unknown> = (raw) =>
  rpcReadUnchecked('linear-issues', extractLinearIssueReadItems(raw))

export const linearIssueSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.issue-search',
    method: 'linear.searchIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: linearIssueReader
  })
)

export const linearAssignedIssueListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.assigned-issue-list',
    method: 'linear.listIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: linearIssueReader
  })
)

/**
 * A repo's owner/repo slug, asked per repo so a pasted cross-repo URL can be matched without
 * assuming github.com syntax. A refusal means "this repo cannot answer", which the caller caches
 * as no slug rather than failing the paste — so refusal is a skip. The caller still reads the
 * refusal code directly, because `method_not_found` is host-wide and retires the whole probe.
 */
export const githubRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.repo-slug-or-skip',
    method: 'github.repoSlug',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('repo-slug')
  })
)

export const githubWorkItemByNumberRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-by-number',
    method: 'github.workItem',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-work-item')
  })
)

export const githubWorkItemBySlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-by-owner-repo',
    method: 'github.workItemByOwnerRepo',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-work-item')
  })
)

export const gitlabWorkItemByPathRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-by-path',
    method: 'gitlab.workItemByPath',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-work-item')
  })
)
