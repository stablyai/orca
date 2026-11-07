import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  jiraCommentListSchema,
  jiraConnectionStatusSchema,
  jiraIssueListSchema,
  jiraIssueRowSchema
} from './jira-reply-schema'

// Credentials and issue mutations stay on desktop.

const jiraStatusReader = rpcResultVariant('jira-status', jiraConnectionStatusSchema)

export const jiraConnectionStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.connection-status',
    method: 'jira.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraStatusReader
  })
)

export const jiraConnectionStatusProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.connection-status-or-skip',
    method: 'jira.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: jiraStatusReader
  })
)

const jiraIssueListReader = rpcResultVariant('jira-issues', jiraIssueListSchema)

export const jiraIssueListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-list',
    method: 'jira.listIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraIssueListReader
  })
)

export const jiraIssueSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-search',
    method: 'jira.searchIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraIssueListReader
  })
)

export const jiraIssueRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue',
    method: 'jira.getIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('jira-issue', jiraIssueRowSchema)
  })
)

export const jiraIssueCommentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-comments-or-skip',
    method: 'jira.issueComments',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('jira-comments', jiraCommentListSchema)
  })
)
