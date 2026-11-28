import type { Store } from '../../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const JIRA_IPC_CHANNELS = [
  'jira:connect',
  'jira:disconnect',
  'jira:selectSite',
  'jira:status',
  'jira:readStatus',
  'jira:testConnection',
  'jira:searchIssues',
  'jira:cancelSearchIssues',
  'jira:listIssues',
  'jira:getIssue',
  'jira:lookupIssueSummary',
  'jira:cancelIssueSummary',
  'jira:createIssue',
  'jira:updateIssue',
  'jira:addIssueComment',
  'jira:issueComments',
  'jira:listFavouriteFilters',
  'jira:listTransitions',
  'jira:getProjectStatusOrder',
  'jira:listProjects',
  'jira:listIssueTypes',
  'jira:listCreateFields',
  'jira:listPriorities',
  'jira:listAssignableUsers',
  'jira:listAssignableUsersForProject',
  'jira:searchUsers',
  'jira:generateIssueSummary',
  'jira:cancelGenerateIssueSummary'
] as const

export function registerLazyJiraHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  registerLazyIpcHandleGroup(JIRA_IPC_CHANNELS, async (ipc) => {
    const [{ registerJiraHandlers }, { registerJiraIssueSummaryGenerationHandlers }] =
      await Promise.all([import('./register-handlers'), import('./issue-summary-generation')])
    registerJiraHandlers(ipc)
    registerJiraIssueSummaryGenerationHandlers(store, commitMessageAgentEnv, ipc)
  })
}
