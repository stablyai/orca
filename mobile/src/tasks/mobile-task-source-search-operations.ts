import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { githubPrRepoSlugSchema } from '../session/github-pr-read-reply-schema'
import {
  taskGitHubWorkItemListSchema,
  taskGitLabWorkItemListSchema,
  taskLinearIssueListSchema,
  taskWorkItemLookupSchema
} from './task-source-search-reply-schema'

export const githubWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-search',
    method: 'github.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-items', taskGitHubWorkItemListSchema)
  })
)

export const gitlabWorkItemSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-search',
    method: 'gitlab.listWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-work-items', taskGitLabWorkItemListSchema)
  })
)

// Linear search/list share a reader accepting both bare arrays and items envelopes.
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

// Cache repo slug refusal as no slug; inspect method_not_found to retire the probe for the whole host.
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
