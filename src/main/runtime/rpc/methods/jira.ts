import {
  JIRA_PAYLOAD_CHUNK_CHARS,
  JIRA_PAYLOAD_MAX_CHARS
} from '../../../../shared/jira-payload-stream'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
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

export const JIRA_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'jira.connect',
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
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraDisconnect(params?.siteId)
  }),
  defineMethod({
    name: 'jira.selectSite',
    params: SelectSite,
    handler: async (params, { runtime }) => runtime.jiraSelectSite(params.siteId.trim())
  }),
  defineMethod({
    name: 'jira.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraStatus()
  }),
  defineMethod({
    name: 'jira.readStatus',
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraReadStatus()
  }),
  defineMethod({
    name: 'jira.testConnection',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraTestConnection(params?.siteId)
  }),
  defineMethod({
    name: 'jira.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime, signal }) =>
      runtime.jiraSearchIssues(params.jql, params.limit, params.siteId, signal)
  }),
  defineMethod({
    name: 'jira.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssues(params?.filter, params?.limit, params?.siteId)
  }),
  defineMethod({
    name: 'jira.getIssue',
    params: IssueKey,
    handler: async (params, { runtime }) => runtime.jiraGetIssue(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.lookupIssueSummary',
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
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(await runtime.jiraGetIssue(params.key.trim(), params.siteId), emit)
    }
  }),
  defineMethod({
    name: 'jira.createIssue',
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
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.jiraUpdateIssue(params.key.trim(), params.updates, params.siteId)
  }),
  defineMethod({
    name: 'jira.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.jiraAddIssueComment(params.key.trim(), params.body.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.issueComments',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraIssueComments(params.key.trim(), params.siteId)
  }),
  defineStreamingMethod({
    name: 'jira.issueCommentsStream',
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(await runtime.jiraIssueComments(params.key.trim(), params.siteId), emit)
    }
  }),
  defineMethod({
    name: 'jira.listProjects',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListProjects(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listIssueTypes',
    params: ProjectIssueTypes,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssueTypes(params.projectIdOrKey.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.listCreateFields',
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
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListPriorities(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listAssignableUsers',
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.jiraListAssignableUsers(params.key.trim(), params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.searchUsers',
    params: UserSearch,
    handler: async (params, { runtime }) => runtime.jiraSearchUsers(params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.listTransitions',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraListTransitions(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.getProjectStatusOrder',
    params: ProjectStatusOrder,
    handler: async (params, { runtime }) =>
      runtime.jiraGetProjectStatusOrder(params.projectKey.trim(), params.siteId)
  })
]
