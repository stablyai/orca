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

// The rest of a task item's writes and the PR reads that go with them: creating an item, editing
// its metadata or state, reviewers, checks, file contents and viewed state, and merge. A mutation
// whose reply is lost stays a transport rejection on the promise, so the screen reports the drop
// rather than a failure the host never sent.
//
// Every reader here is checked, and each schema lives in task-item-state-reply-schema.ts with the
// consumer line behind every requirement. Nine of the writes share one reader because they share
// one reply convention; the acceptance and the name stay per operation, which is what a call site
// picks.

/**
 * One reader for the nine writes whose reply is a `{ ok, error }` envelope, not nine readers.
 *
 * The `ok === false` test and the `error` read are a single convention across both issue edits,
 * both pull/merge-request edits, both state toggles, the reviewer request, the checks rerun and
 * both merges — there is no input on which two of them would want different answers. Which
 * sentence a caller shows on a refusal stays the caller's, because each keeps its own fallback
 * copy.
 */
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

/** The composer and the sub-issue field both create through this; each keeps its own copy. */
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

/** Both readers of this reply require an array and raise their own copy otherwise. */
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

/** Syncing one file's viewed state. Like the thread toggle, the reply is `true` or nothing ran. */
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
