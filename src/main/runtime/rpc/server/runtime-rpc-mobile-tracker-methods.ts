import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

/** Linear and Jira have no workspace; untagged phone calls use the desktop's "New projects open on" host, as its Tasks page does. */
export const DEFAULT_SCOPE_HOST_METHODS = [
  'jira.attachmentImage',
  'jira.getIssue',
  'jira.issueComments',
  'jira.listIssues',
  'jira.searchIssues',
  'jira.status',
  'linear.addIssueComment',
  'linear.agentSearchIssues',
  'linear.connect',
  'linear.createIssue',
  'linear.createProject',
  'linear.getCustomView',
  'linear.getIssue',
  'linear.getProject',
  'linear.issueComments',
  'linear.issueContext',
  'linear.listCustomViewIssues',
  'linear.listCustomViewProjects',
  'linear.listCustomViews',
  'linear.listIssues',
  'linear.listProjectIssues',
  'linear.listProjects',
  'linear.listTeams',
  'linear.mcpListIssues',
  'linear.searchIssues',
  'linear.selectWorkspace',
  'linear.status',
  'linear.teamLabels',
  'linear.teamMembers',
  'linear.teamStates',
  'linear.updateIssue'
] as const

/** The server an untagged tracker call goes to; this desktop answers when its default is itself. */
export function defaultScopeServer(
  method: string,
  runtime: { getClientDefaultScopeHost: () => ExecutionHostId }
): ExecutionHostId | undefined {
  const tracker = (DEFAULT_SCOPE_HOST_METHODS as readonly string[]).includes(method)
  const host = tracker ? runtime.getClientDefaultScopeHost() : undefined
  return host?.startsWith('runtime:') ? host : undefined
}
