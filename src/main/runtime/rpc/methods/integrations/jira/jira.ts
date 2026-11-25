import {
  JIRA_PAYLOAD_CHUNK_CHARS,
  JIRA_PAYLOAD_MAX_CHARS
} from '../../../../../../shared/jira/jira-payload-stream'
import { notShared, defineMethod, defineStreamingMethod, type RpcContext } from '../../../core'
import { JIRA_ATTACHMENT_IMAGE_METHODS } from './jira-attachment-image'
import { JiraFavouriteFilterParams } from '../../../../../../shared/rpc-contract/jira/jira-favourite-filter-params'
import {
  AssignableUsers,
  GenerateIssueSummary,
  CancelGenerateIssueSummary,
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
} from '../../../../../../shared/rpc-contract/jira/jira-params'

/** Emits a Jira result over RPC, normalizing it to the shape clients decode. */
function emitJiraPayload(value: unknown, emit: (result: unknown) => void): void {
  const payload = JSON.stringify(value)
  if (payload.length > JIRA_PAYLOAD_MAX_CHARS) {
    throw new Error('Jira payload exceeded the transfer limit.')
  }
  // Chunk inline images under the remote WebSocket's 1 MiB frame cap, including SSH.
  for (let offset = 0; offset < payload.length; offset += JIRA_PAYLOAD_CHUNK_CHARS) {
    emit({ type: 'chunk', content: payload.slice(offset, offset + JIRA_PAYLOAD_CHUNK_CHARS) })
  }
  emit({ type: 'end' })
}

function generationOwner(context: Pick<RpcContext, 'pairedDeviceId' | 'caller'>): string {
  // One-shot RPCs use different sockets for Generate and Stop.
  if (context.pairedDeviceId) {
    return `device:${context.pairedDeviceId}`
  }
  if (context.caller?.kind === 'paired-device') {
    return `device:${context.caller.deviceId}`
  }
  if (context.caller?.kind === 'local-cli') {
    return 'local-cli'
  }
  throw new Error('A title generation request needs an authenticated connection.')
}

export const JIRA_METHODS = [
  ...JIRA_ATTACHMENT_IMAGE_METHODS,
  defineMethod({
    name: 'jira.generateIssueSummary',
    ...notShared('workspace'),
    params: GenerateIssueSummary,
    handler: (params, context) =>
      context.runtime.jiraGenerateIssueSummary(params, generationOwner(context), context.signal)
  }),
  defineMethod({
    name: 'jira.cancelGenerateIssueSummary',
    ...notShared('workspace'),
    params: CancelGenerateIssueSummary,
    handler: (params, context) =>
      context.runtime.jiraCancelGenerateIssueSummary(params, generationOwner(context))
  }),
  defineMethod({
    name: 'jira.connect',
    ...notShared('accounts-admin'),
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
    ...notShared('accounts-admin'),
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraDisconnect(params?.siteId)
  }),
  defineMethod({
    name: 'jira.selectSite',
    ...notShared('accounts-admin'),
    params: SelectSite,
    handler: async (params, { runtime }) => runtime.jiraSelectSite(params.siteId.trim())
  }),
  defineMethod({
    name: 'jira.status',
    ...notShared('workspace'),
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraStatus()
  }),
  defineMethod({
    name: 'jira.readStatus',
    ...notShared('workspace'),
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraReadStatus()
  }),
  defineMethod({
    name: 'jira.testConnection',
    ...notShared('workspace'),
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraTestConnection(params?.siteId)
  }),
  defineMethod({
    name: 'jira.searchIssues',
    ...notShared('workspace'),
    params: SearchIssues,
    handler: async (params, { runtime, signal }) =>
      runtime.jiraSearchIssues(params.jql, params.limit, params.siteId, signal, params.strict)
  }),
  defineMethod({
    name: 'jira.listIssues',
    ...notShared('workspace'),
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssues(
        params?.filter,
        params?.limit,
        params?.siteId,
        params?.strict,
        params?.filters
      )
  }),
  defineMethod({
    name: 'jira.getIssue',
    ...notShared('workspace'),
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraGetIssue(params.key.trim(), params.siteId, params.strict, params.mediaFormat)
  }),
  defineMethod({
    name: 'jira.lookupIssueSummary',
    ...notShared('workspace'),
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
    ...notShared('workspace'),
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(
        await runtime.jiraGetIssue(
          params.key.trim(),
          params.siteId,
          params.strict,
          params.mediaFormat
        ),
        emit
      )
    }
  }),
  defineMethod({
    name: 'jira.createIssue',
    ...notShared('workspace'),
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
    ...notShared('workspace'),
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.jiraUpdateIssue(params.key.trim(), params.updates, params.siteId)
  }),
  defineMethod({
    name: 'jira.addIssueComment',
    ...notShared('workspace'),
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.jiraAddIssueComment(params.key.trim(), params.body.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.issueComments',
    ...notShared('workspace'),
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraIssueComments(params.key.trim(), params.siteId, params.strict, params.mediaFormat)
  }),
  defineStreamingMethod({
    name: 'jira.issueCommentsStream',
    ...notShared('workspace'),
    params: IssueKey,
    handler: async (params, { runtime }, emit) => {
      emitJiraPayload(
        await runtime.jiraIssueComments(
          params.key.trim(),
          params.siteId,
          params.strict,
          params.mediaFormat
        ),
        emit
      )
    }
  }),
  defineMethod({
    name: 'jira.listFavouriteFilters',
    ...notShared('workspace'),
    params: JiraFavouriteFilterParams,
    handler: async (params, { runtime, signal }) =>
      runtime.jiraListFavouriteFilters(params.siteId, signal)
  }),
  defineMethod({
    name: 'jira.listProjects',
    ...notShared('workspace'),
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListProjects(params?.siteId, params?.strict)
  }),
  defineMethod({
    name: 'jira.listIssueTypes',
    ...notShared('workspace'),
    params: ProjectIssueTypes,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssueTypes(params.projectIdOrKey.trim(), params.siteId, params.strict)
  }),
  defineMethod({
    name: 'jira.listCreateFields',
    ...notShared('workspace'),
    params: ProjectIssueTypeFields,
    handler: async (params, { runtime }) =>
      runtime.jiraListCreateFields(
        params.projectIdOrKey.trim(),
        params.issueTypeId.trim(),
        params.siteId,
        params.strict
      )
  }),
  defineMethod({
    name: 'jira.listPriorities',
    ...notShared('workspace'),
    params: SiteSelection,
    handler: async (params, { runtime }) =>
      runtime.jiraListPriorities(params?.siteId, params?.strict)
  }),
  defineMethod({
    name: 'jira.listAssignableUsers',
    ...notShared('workspace'),
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.jiraListAssignableUsers(params.key.trim(), params.query, params.siteId, params.strict)
  }),
  defineMethod({
    name: 'jira.searchUsers',
    ...notShared('workspace'),
    params: UserSearch,
    handler: async (params, { runtime }) => runtime.jiraSearchUsers(params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.listTransitions',
    ...notShared('workspace'),
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraListTransitions(params.key.trim(), params.siteId, params.strict)
  }),
  defineMethod({
    name: 'jira.getProjectStatusOrder',
    ...notShared('workspace'),
    params: ProjectStatusOrder,
    handler: async (params, { runtime }) =>
      runtime.jiraGetProjectStatusOrder(params.projectKey.trim(), params.siteId)
  })
]
