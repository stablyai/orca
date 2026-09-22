import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  jiraCommentListSchema,
  jiraConnectionStatusSchema,
  jiraIssueListSchema,
  jiraIssueRowSchema
} from './jira-reply-schema'

// The read-only Jira surface mobile is allowed to reach: browse issues, open one, and switch the
// site a read targets. Connecting a site stays on desktop, so no operation here writes one.
// Readers are checked against jira-reply-schema.ts.

const jiraStatusReader = rpcResultVariant('jira-status', jiraConnectionStatusSchema)

/**
 * Whether Jira is connected, and which sites it can read, on the explicit re-check the connect
 * prompt offers.
 *
 * `require-result-or-throw-message` rather than a skip: a host that refuses `jira.*` is not the
 * same as a host with no Jira connected, and mapping the refusal to "disconnected" hid it behind a
 * setup prompt the user could never satisfy. The re-check is what surfaces the host's own message.
 */
export const jiraConnectionStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.connection-status',
    method: 'jira.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraStatusReader
  })
)

/**
 * The same status, asked at a hydration barrier alongside preflight and Linear status. Advisory
 * there, as those two are: a host that predates the Jira RPCs must still reach a Tasks screen, so
 * an unanswered probe means "not connected" and the connect prompt takes over.
 */
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

/** The Tasks list with no query: a named filter (assigned/reported/all/done) on the chosen site. */
export const jiraIssueListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-list',
    method: 'jira.listIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraIssueListReader
  })
)

/** The Tasks search box, which sends raw JQL, and the composer's built key/text query. */
export const jiraIssueSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-search',
    method: 'jira.searchIssues',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: jiraIssueListReader
  })
)

/** One issue, for the detail sheet and for resolving a pasted Jira link. */
export const jiraIssueRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue',
    method: 'jira.getIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('jira-issue', jiraIssueRowSchema)
  })
)

/**
 * The detail sheet's comments. Advisory: the issue is readable without them, and the sheet has
 * always shown an issue whose comments failed, so a refusal is a skip rather than a thrown detail.
 */
export const jiraIssueCommentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.issue-comments-or-skip',
    method: 'jira.issueComments',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('jira-comments', jiraCommentListSchema)
  })
)

/**
 * Switching which site the reads target. Declared but never interpreted, and deliberately: the
 * picker chains a connection refresh off the send without reading the reply, so a refused switch
 * re-reads status exactly as an accepted one does.
 */
export const jiraSiteSelectWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'jira.select-site',
    method: 'jira.selectSite',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: jiraStatusReader
  })
)
