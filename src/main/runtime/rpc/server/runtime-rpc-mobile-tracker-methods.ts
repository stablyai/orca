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

// Structural, not RpcRequest: the CLI typecheck reaches this file, and core.ts would pull in all of main.
type TrackerCall = { method: string; executionHost?: unknown }

export function isUntaggedTrackerCall(request: TrackerCall): boolean {
  return (
    request.executionHost === undefined &&
    DEFAULT_SCOPE_HOST_METHODS.some((method) => method === request.method)
  )
}

/**
 * Sends the call to the desktop's default server when a phone can reach it there now. Otherwise this
 * desktop answers, as before: an old, offline or sleeping server must not stall or wake for Tasks.
 */
export async function withDefaultScopeServer<Request extends TrackerCall>(
  request: Request,
  runtime: { getClientDefaultScopeHost: () => ExecutionHostId },
  relayHosts: { relayReady: (hostId: ExecutionHostId) => Promise<boolean> } | null
): Promise<Request> {
  const host = runtime.getClientDefaultScopeHost()
  if (!host.startsWith('runtime:') || !(await relayHosts?.relayReady(host))) {
    return request
  }
  return { ...request, executionHost: host }
}
