import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  githubPullRequestChecksSchema,
  githubPullRequestFileContentsSchema,
  hostedIssueCreatedSchema,
  linearIssueCreatedSchema,
  linearIssueUpdatedSchema,
  taskItemMutationSchema,
  taskMutationConfirmationSchema
} from './task-item-state-reply-schema'

// Preserve lost mutation replies as transport rejections; a missing answer does not prove host failure.

// Writes share the ok/error envelope convention; refusal fallback copy stays with each caller.
const taskItemMutationReader = rpcResultVariant('task-item-mutation', taskItemMutationSchema)

export const githubIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.create-issue',
    method: 'github.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-created-issue', hostedIssueCreatedSchema)
  })
)

export const gitlabIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.create-issue',
    method: 'gitlab.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-created-issue', hostedIssueCreatedSchema)
  })
)

export const linearIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.create-issue',
    method: 'linear.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-created-issue', linearIssueCreatedSchema)
  })
)

export const githubIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-issue',
    method: 'github.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const githubPullRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pull-request',
    method: 'github.updatePR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const githubPullRequestStateUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pull-request-state',
    method: 'github.updatePRState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const gitlabIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-issue',
    method: 'gitlab.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const gitlabMergeRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-merge-request',
    method: 'gitlab.updateMR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const gitlabMergeRequestStateUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-merge-request-state',
    method: 'gitlab.updateMRState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const linearIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.update-issue',
    method: 'linear.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-updated-issue', linearIssueUpdatedSchema)
  })
)

export const githubReviewerRequest = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.request-pr-reviewers',
    method: 'github.requestPRReviewers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const githubPullRequestChecksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-checks',
    method: 'github.prChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-pr-checks', githubPullRequestChecksSchema)
  })
)

export const githubPullRequestChecksRerun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.rerun-pr-checks',
    method: 'github.rerunPRChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const githubPullRequestFileContentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-file-contents',
    method: 'github.prFileContents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-pr-file-contents', githubPullRequestFileContentsSchema)
  })
)

export const githubPullRequestFileViewedWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.set-pr-file-viewed',
    method: 'github.setPRFileViewed',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-pr-file-viewed', taskMutationConfirmationSchema)
  })
)

export const githubPullRequestMerge = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.merge-pull-request',
    method: 'github.mergePR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)

export const gitlabMergeRequestMerge = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.merge-merge-request',
    method: 'gitlab.mergeMR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskItemMutationReader
  })
)
