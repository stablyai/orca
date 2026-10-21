import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { githubPrRepoSlugSchema } from '../session/github-pr-read-reply-schema'
import {
  taskGitHubWorkItemListSchema,
  taskGitLabWorkItemListSchema,
  taskLinearIssueListSchema,
  taskWorkItemLookupSchema
} from './task-source-search-reply-schema'

// The Smart workspace-source picker's provider reads: per-repo search, and the single-item lookups
// a pasted link or number resolves to. Provider-specific fallbacks stay at their own call sites,
// and the readers are checked against task-source-search-reply-schema.ts.

export const githubWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-search',
    method: 'github.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-items', taskGitHubWorkItemListSchema)
  })
)

/** GitLab answers in-band too: an accepted reply can carry a provider `error` the caller raises. */
export const gitlabWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-search',
    method: 'gitlab.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-work-items', taskGitLabWorkItemListSchema)
  })
)

// Linear replies either as a bare array or as an `{ items }` envelope, and the picker has always
// accepted both through this projection. Two operations share it because the empty-query path asks
// a different method, not because the two answers differ. The union in the schema is what used to
// be linear-mobile-issue-read.ts's hand reader, whose `throw new Error('Unexpected Linear tasks
// response')` reached the screen as unattributed copy; the same payloads now name the method.
const linearIssueReader = rpcResultVariant('linear-issues', taskLinearIssueListSchema)

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
    read: rpcResultVariant('repo-slug', githubPrRepoSlugSchema)
  })
)

export const githubWorkItemByNumberRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-by-number',
    method: 'github.workItem',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-item', taskWorkItemLookupSchema)
  })
)

export const githubWorkItemBySlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-by-owner-repo',
    method: 'github.workItemByOwnerRepo',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-item', taskWorkItemLookupSchema)
  })
)

export const gitlabWorkItemByPathRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-by-path',
    method: 'gitlab.workItemByPath',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-work-item', taskWorkItemLookupSchema)
  })
)
