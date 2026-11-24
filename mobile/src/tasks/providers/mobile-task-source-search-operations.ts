import type { GitHubWorkItem } from '../../../../src/shared/github/work-items/work-item-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { githubPrRepoSlugSchema } from '../../source-control/review/github-operations/github-pr-read-reply-schema'
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

export async function readGitHubWorkItemByNumber(
  client: RpcClient,
  params: { repo: string; number: number; type?: 'issue' | 'pr' },
  // A rest tuple keeps the request's recorded arity when no options are given.
  ...options: [SendRequestOptions?]
): Promise<GitHubWorkItem | null> {
  const reply = await githubWorkItemByNumberRead.request(client, params, ...options)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup decodes the same `workItemRow`, so the assertion only fills in members the row omits, each read through a guard or interpolated as text; what the schema adds is that a non-object payload is now a named incompatible reply rather than a spread over a string.
  return githubWorkItemByNumberRead.interpret(reply) as GitHubWorkItem | null
}

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
