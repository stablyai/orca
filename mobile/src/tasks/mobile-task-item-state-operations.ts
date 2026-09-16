import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// The rest of a task item's writes and the PR reads that go with them: creating an item, editing
// its metadata or state, reviewers, checks, file contents and viewed state, and merge. A mutation
// whose reply is lost stays a transport rejection on the promise, so the screen reports the drop
// rather than a failure the host never sent.

export const githubIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.create-issue',
    method: 'github.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-created-issue')
  })
)

export const gitlabIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.create-issue',
    method: 'gitlab.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-created-issue')
  })
)

/** The composer and the sub-issue field both create through this; each keeps its own copy. */
export const linearIssueCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.create-issue',
    method: 'linear.createIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('linear-created-issue')
  })
)

export const githubIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-issue',
    method: 'github.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-updated-issue')
  })
)

export const githubPullRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pull-request',
    method: 'github.updatePR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-updated-pull-request')
  })
)

export const githubPullRequestStateUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pull-request-state',
    method: 'github.updatePRState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-updated-pull-request-state')
  })
)

export const gitlabIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-issue',
    method: 'gitlab.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-updated-issue')
  })
)

export const gitlabMergeRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-merge-request',
    method: 'gitlab.updateMR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-updated-merge-request')
  })
)

export const gitlabMergeRequestStateUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.update-merge-request-state',
    method: 'gitlab.updateMRState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-updated-merge-request-state')
  })
)

export const linearIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.update-issue',
    method: 'linear.updateIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('linear-updated-issue')
  })
)

export const githubReviewerRequest = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.request-pr-reviewers',
    method: 'github.requestPRReviewers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-requested-reviewers')
  })
)

/** Both readers of this reply require an array and raise their own copy otherwise. */
export const githubPullRequestChecksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-checks',
    method: 'github.prChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-pr-checks')
  })
)

export const githubPullRequestChecksRerun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.rerun-pr-checks',
    method: 'github.rerunPRChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-rerun-pr-checks')
  })
)

export const githubPullRequestFileContentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-file-contents',
    method: 'github.prFileContents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-pr-file-contents')
  })
)

/** Syncing one file's viewed state. Like the thread toggle, the reply is `true` or nothing ran. */
export const githubPullRequestFileViewedWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.set-pr-file-viewed',
    method: 'github.setPRFileViewed',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-pr-file-viewed')
  })
)

export const githubPullRequestMerge = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.merge-pull-request',
    method: 'github.mergePR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-merged-pull-request')
  })
)

export const gitlabMergeRequestMerge = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.merge-merge-request',
    method: 'gitlab.mergeMR',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-merged-merge-request')
  })
)
