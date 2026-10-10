import { defineMethod } from '../core'
import { LINEAR_PROJECT_CREATE_METHOD } from './linear-project-create'
import { LINEAR_ISSUE_LIST_METHOD, LINEAR_MCP_ISSUE_LIST_METHOD } from './linear-issue-list-method'
import {
  Connect,
  CreateIssue,
  CustomViewContents,
  CustomViewId,
  IssueComment,
  IssueId,
  IssueUpdate,
  LinearIssueCommentsParams,
  ListCustomViews,
  ListProjects,
  ProjectId,
  ProjectIssues,
  SearchIssues,
  SelectWorkspace,
  TeamId,
  WorkspaceSelection
} from '../../../../shared/rpc-contract/linear-params'

export const LINEAR_METHODS = [
  defineMethod({
    name: 'linear.connect',
    permission: 'accounts-admin',
    params: Connect,
    handler: async (params, { runtime }) => runtime.linearConnect(params.apiKey.trim())
  }),
  defineMethod({
    name: 'linear.disconnect',
    permission: 'accounts-admin',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearDisconnect(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.selectWorkspace',
    permission: 'accounts-admin',
    params: SelectWorkspace,
    handler: async (params, { runtime }) => runtime.linearSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'linear.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.linearStatus()
  }),
  defineMethod({
    name: 'linear.testConnection',
    permission: 'workspace',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearTestConnection(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.searchIssues',
    permission: 'workspace',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.linearSearchIssues(params.query, params.limit, params.workspaceId)
  }),
  LINEAR_ISSUE_LIST_METHOD,
  LINEAR_MCP_ISSUE_LIST_METHOD,
  defineMethod({
    name: 'linear.createIssue',
    permission: 'workspace',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.linearCreateIssue(
        params.teamId.trim(),
        params.title.trim(),
        params.description?.trim() || undefined,
        params.workspaceId,
        params.parentIssueId,
        params.projectId,
        {
          stateId: params.stateId,
          priority: params.priority,
          assigneeId: params.assigneeId,
          labelIds: params.labelIds
        }
      )
  }),
  defineMethod({
    name: 'linear.getIssue',
    permission: 'workspace',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.linearGetIssue(params.id.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.updateIssue',
    permission: 'workspace',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.linearUpdateIssue(params.id.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'linear.addIssueComment',
    permission: 'workspace',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.linearAddIssueComment(params.issueId.trim(), params.body.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.issueComments',
    permission: 'workspace',
    params: LinearIssueCommentsParams,
    handler: async (params, { runtime }) =>
      runtime.linearIssueComments(params.issueId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.listTeams',
    permission: 'workspace',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearListTeams(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.listProjects',
    permission: 'workspace',
    params: ListProjects,
    handler: async (params, { runtime }) =>
      runtime.linearListProjects(params?.query, params?.limit, params?.workspaceId, params?.force)
  }),
  LINEAR_PROJECT_CREATE_METHOD,
  defineMethod({
    name: 'linear.getProject',
    permission: 'workspace',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.linearGetProject(params.id.trim(), params.workspaceId.trim(), params.force)
  }),
  defineMethod({
    name: 'linear.listProjectIssues',
    permission: 'workspace',
    params: ProjectIssues,
    handler: async (params, { runtime }) =>
      runtime.linearListProjectIssues(
        params.projectId.trim(),
        params.limit,
        params.workspaceId.trim(),
        params.force
      )
  }),
  defineMethod({
    name: 'linear.listCustomViews',
    permission: 'workspace',
    params: ListCustomViews,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViews(params.model, params.limit, params.workspaceId, params.force)
  }),
  defineMethod({
    name: 'linear.getCustomView',
    permission: 'workspace',
    params: CustomViewId,
    handler: async (params, { runtime }) =>
      runtime.linearGetCustomView(
        params.viewId.trim(),
        params.model,
        params.workspaceId.trim(),
        params.force
      )
  }),
  defineMethod({
    name: 'linear.listCustomViewIssues',
    permission: 'workspace',
    params: CustomViewContents,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViewIssues(
        params.viewId.trim(),
        params.limit,
        params.workspaceId.trim(),
        params.force
      )
  }),
  defineMethod({
    name: 'linear.listCustomViewProjects',
    permission: 'workspace',
    params: CustomViewContents,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViewProjects(
        params.viewId.trim(),
        params.limit,
        params.workspaceId.trim(),
        params.force
      )
  }),
  defineMethod({
    name: 'linear.teamStates',
    permission: 'workspace',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamStates(params.teamId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.teamLabels',
    permission: 'workspace',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamLabels(params.teamId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.teamMembers',
    permission: 'workspace',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamMembers(params.teamId.trim(), params.workspaceId)
  })
]
