import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import {
  jiraCommentListSchema,
  jiraConnectionStatusSchema,
  jiraIssueListSchema,
  jiraIssueRowSchema
} from './jira-reply-schema'
import { taskMutationEnvelopeSchema } from '../../task-provider-entity-reply-schema'

/** The tracker host's own phone allowlist lacks jira.connect (an older server behind this desktop). */
export class JiraConnectRefusedError extends Error {}

// Accepted replies may still fail in-band with the host's message (bad token, bad site URL).
export const jiraAccountConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.connect-account',
    method: 'jira.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('jira-account-connected', taskMutationEnvelopeSchema)
  })
)

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
