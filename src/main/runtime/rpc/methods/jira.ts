import {
  JIRA_PAYLOAD_CHUNK_CHARS,
  JIRA_PAYLOAD_MAX_CHARS
} from '../../../../shared/jira-payload-stream'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  AssignableUsers,
  Connect,
  CreateIssue,
  IssueComment,
  IssueKey,
  IssueUpdate,
  ListIssues,
  ProjectIssueTypeFields,
  ProjectIssueTypes,
  ProjectStatusOrder,
  SearchIssues,
  SelectSite,
  SiteSelection,
  UserSearch
} from '../../../../shared/rpc-contract/jira-params'

/** Emits a Jira result over RPC, normalizing it to the shape clients decode. */
function emitJiraPayload(value: unknown, emit: (result: unknown) => void): void {
  const payload = JSON.stringify(value)
  if (payload.length > JIRA_PAYLOAD_MAX_CHARS) {
    throw new Error('Jira payload exceeded the transfer limit.')
  }
  // Why: remote runtime WebSocket messages are capped at 1 MiB; chunking keeps
  // authenticated inline images usable over SSH without raising that safety cap.
  for (let offset = 0; offset < payload.length; offset += JIRA_PAYLOAD_CHUNK_CHARS) {
    emit({ type: 'chunk', content: payload.slice(offset, offset + JIRA_PAYLOAD_CHUNK_CHARS) })
  }
  emit({ type: 'end' })
}

export const JIRA_METHODS = [
  defineMethod({
    name: 'jira.connect',
    permission: 'accounts-admin',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.jiraConnect({
        siteUrl: params.siteUrl.trim(),
        email: params.email?.trim() ?? '',
        apiToken: params.apiToken.trim(),
        authType: params.authType
      })
  }),
  defineMethod({
    name: 'jira.disconnect',
    permission: 'accounts-admin',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraDisconnect(params?.siteId)
  }),
  defineMethod({
    name: 'jira.selectSite',
    permission: 'accounts-admin',
    params: SelectSite,
    handler: async (params, { runtime }) => runtime.jiraSelectSite(params.siteId.trim())
  }),
  defineMethod({
    name: 'jira.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraStatus()
  }),
  defineMethod({
    name: 'jira.readStatus',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraReadStatus()
  }),
  defineMethod({
    name: 'jira.testConnection',
    permission: 'workspace',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraTestConnection(params?.siteId)
  }),
  defineMethod({
    name: 'jira.searchIssues',
    permission: 'workspace',
    params: SearchIssues,
    handler: async (params, { runtime, signal }) =>
      runtime.jiraSearchIssues(params.jql, params.limit, params.siteId, signal)
  }),
  defineMethod({
    name: 'jira.listIssues',
    permission: 'workspace',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssues(params?.filter, params?.limit, params?.siteId)
  }),
  defineMethod({
    name: 'jira.getIssue',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime }) => runtime.jiraGetIssue(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.lookupIssueSummary',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime, signal }) => {
      if (!params.siteId) {
        throw new Error('Site ID is required')
      }
      return runtime.jiraLookupIssueSummary(params.key.trim(), params.siteId, signal)
    }
  }),
  defineStreamingMethod({
    name: 'jira.getIssueStream',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(await runtime.jiraGetIssue(params.key.trim(), params.siteId), emit)
    }
  }),
  defineMethod({
    name: 'jira.createIssue',
    permission: 'workspace',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.jiraCreateIssue({
        siteId: params.siteId,
        projectId: params.projectId.trim(),
        issueTypeId: params.issueTypeId.trim(),
        title: params.title.trim(),
        description: params.description?.trim() || undefined,
        customFields: params.customFields,
        userFieldKeys: params.userFieldKeys
      })
  }),
  defineMethod({
    name: 'jira.updateIssue',
    permission: 'workspace',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.jiraUpdateIssue(params.key.trim(), params.updates, params.siteId)
  }),
  defineMethod({
    name: 'jira.addIssueComment',
    permission: 'workspace',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.jiraAddIssueComment(params.key.trim(), params.body.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.issueComments',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraIssueComments(params.key.trim(), params.siteId)
  }),
  defineStreamingMethod({
    name: 'jira.issueCommentsStream',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(await runtime.jiraIssueComments(params.key.trim(), params.siteId), emit)
    }
  }),
  defineMethod({
    name: 'jira.listProjects',
    permission: 'workspace',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListProjects(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listIssueTypes',
    permission: 'workspace',
    params: ProjectIssueTypes,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssueTypes(params.projectIdOrKey.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.listCreateFields',
    permission: 'workspace',
    params: ProjectIssueTypeFields,
    handler: async (params, { runtime }) =>
      runtime.jiraListCreateFields(
        params.projectIdOrKey.trim(),
        params.issueTypeId.trim(),
        params.siteId
      )
  }),
  defineMethod({
    name: 'jira.listPriorities',
    permission: 'workspace',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListPriorities(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listAssignableUsers',
    permission: 'workspace',
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.jiraListAssignableUsers(params.key.trim(), params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.searchUsers',
    permission: 'workspace',
    params: UserSearch,
    handler: async (params, { runtime }) => runtime.jiraSearchUsers(params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.listTransitions',
    permission: 'workspace',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraListTransitions(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.getProjectStatusOrder',
    permission: 'workspace',
    params: ProjectStatusOrder,
    handler: async (params, { runtime }) =>
      runtime.jiraGetProjectStatusOrder(params.projectKey.trim(), params.siteId)
  })
]
