import type {
  JiraIssueSummaryGenerationRequest,
  JiraIssueSummaryGenerationCancellation
} from '../../shared/jira-issue-summary-generation'
import {
  generateJiraIssueSummaryRequest,
  cancelJiraIssueSummaryRequest,
  type JiraIssueSummaryGenerationHost
} from '../text-generation/jira-issue-summary-requests'
import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../shared/jira-types'
import type { JiraMediaFormat } from '../../shared/jira/jira-attachment-image'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../jira/client'
import { listFavouriteFilters } from '../jira/favourite-filters'
import {
  addIssueComment,
  createIssue,
  getIssue,
  getIssueComments,
  getIssueSummary,
  getProjectStatusOrder,
  listAssignableUsers,
  listCreateFields,
  listIssueTypes,
  listIssues,
  listPriorities,
  listProjects,
  listTransitions,
  searchIssues,
  searchUsers,
  updateIssue
} from '../jira/issues'

export class RuntimeJiraCommands {
  constructor(private readonly host: JiraIssueSummaryGenerationHost) {}

  jiraGenerateIssueSummary(
    args: JiraIssueSummaryGenerationRequest,
    owner: string,
    signal?: AbortSignal
  ) {
    return generateJiraIssueSummaryRequest(this.host, owner, args, signal)
  }

  jiraCancelGenerateIssueSummary(
    args: JiraIssueSummaryGenerationCancellation,
    owner: string
  ): { ok: true } {
    cancelJiraIssueSummaryRequest(owner, args)
    return { ok: true }
  }

  jiraConnect(args: JiraConnectArgs): ReturnType<typeof connect> {
    return connect(args)
  }

  jiraDisconnect(siteId?: string): { ok: true } {
    disconnect(siteId)
    return { ok: true }
  }

  jiraSelectSite(siteId: JiraSiteSelection): ReturnType<typeof getStatus> {
    return selectSite(siteId)
  }

  jiraStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  jiraReadStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  jiraTestConnection(siteId?: string): ReturnType<typeof testConnection> {
    return testConnection(siteId)
  }

  jiraSearchIssues(
    jql: string,
    limit = 30,
    siteId?: JiraSiteSelection,
    signal?: AbortSignal,
    strict = false
  ): ReturnType<typeof searchIssues> {
    return searchIssues(jql, Math.min(Math.max(1, limit), 100), siteId, signal, strict)
  }

  jiraListIssues(
    filter?: JiraIssueFilter,
    limit = 30,
    siteId?: JiraSiteSelection,
    strict = false,
    filters?: JiraIssueListFilters
  ): ReturnType<typeof listIssues> {
    return listIssues(filter, Math.min(Math.max(1, limit), 100), siteId, strict, filters)
  }

  jiraCreateIssue(args: JiraCreateIssueArgs): ReturnType<typeof createIssue> {
    return createIssue(args)
  }

  jiraGetIssue(
    key: string,
    siteId?: string,
    strict = false,
    mediaFormat?: JiraMediaFormat
  ): ReturnType<typeof getIssue> {
    return getIssue(key, siteId, strict, mediaFormat)
  }

  jiraLookupIssueSummary(
    key: string,
    siteId: string,
    signal?: AbortSignal
  ): ReturnType<typeof getIssueSummary> {
    return getIssueSummary(key, siteId, signal)
  }

  jiraUpdateIssue(
    key: string,
    updates: JiraIssueUpdate,
    siteId?: string
  ): ReturnType<typeof updateIssue> {
    return updateIssue(key, updates, siteId)
  }

  jiraAddIssueComment(
    key: string,
    body: string,
    siteId?: string
  ): ReturnType<typeof addIssueComment> {
    return addIssueComment(key, body, siteId)
  }

  jiraIssueComments(
    key: string,
    siteId?: string,
    strict = false,
    mediaFormat?: JiraMediaFormat
  ): ReturnType<typeof getIssueComments> {
    return getIssueComments(key, siteId, strict, mediaFormat)
  }

  jiraListProjects(siteId?: JiraSiteSelection, strict = false): ReturnType<typeof listProjects> {
    return listProjects(siteId, strict)
  }

  jiraListFavouriteFilters(
    siteId: string,
    signal?: AbortSignal
  ): ReturnType<typeof listFavouriteFilters> {
    return listFavouriteFilters(siteId, signal)
  }

  jiraListIssueTypes(
    projectIdOrKey: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listIssueTypes> {
    return listIssueTypes(projectIdOrKey, siteId, strict)
  }

  jiraListCreateFields(
    projectIdOrKey: string,
    issueTypeId: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listCreateFields> {
    return listCreateFields(projectIdOrKey, issueTypeId, siteId, strict)
  }

  jiraListPriorities(siteId?: string, strict = false): ReturnType<typeof listPriorities> {
    return listPriorities(siteId, strict)
  }

  jiraListAssignableUsers(
    key: string,
    query?: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listAssignableUsers> {
    return listAssignableUsers(key, query, siteId, strict)
  }

  /** Searches all users on the site, for reporter and user-picker create fields. */
  jiraSearchUsers(query?: string, siteId?: string): ReturnType<typeof searchUsers> {
    return searchUsers(query, siteId)
  }

  jiraListTransitions(
    key: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listTransitions> {
    return listTransitions(key, siteId, strict)
  }

  jiraGetProjectStatusOrder(
    projectKey: string,
    siteId?: string
  ): ReturnType<typeof getProjectStatusOrder> {
    return getProjectStatusOrder(projectKey, siteId)
  }
}
