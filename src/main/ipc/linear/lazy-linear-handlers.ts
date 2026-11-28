import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const LINEAR_IPC_CHANNELS = [
  'linear:connect',
  'linear:disconnect',
  'linear:selectWorkspace',
  'linear:status',
  'linear:testConnection',
  'linear:searchIssues',
  'linear:listIssues',
  'linear:createIssue',
  'linear:getIssue',
  'linear:updateIssue',
  'linear:addIssueComment',
  'linear:issueComments',
  'linear:listProjects',
  'linear:createProject',
  'linear:getProject',
  'linear:listProjectIssues',
  'linear:listCustomViews',
  'linear:getCustomView',
  'linear:listCustomViewIssues',
  'linear:listCustomViewProjects',
  'linear:listTeams',
  'linear:teamStates',
  'linear:teamLabels',
  'linear:teamMembers'
] as const

export function registerLazyLinearHandlers(): void {
  registerLazyIpcHandleGroup(LINEAR_IPC_CHANNELS, async (ipc) => {
    const { registerLinearHandlers } = await import('./register-handlers')
    registerLinearHandlers(ipc)
  })
}
