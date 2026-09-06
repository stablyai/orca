import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../shared/jira-types'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../jira/client'
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
    signal?: AbortSignal
  ): ReturnType<typeof searchIssues> {
    return searchIssues(jql, Math.min(Math.max(1, limit), 100), siteId, signal)
  }

  jiraListIssues(
    filter?: JiraIssueFilter,
    limit = 30,
    siteId?: JiraSiteSelection
  ): ReturnType<typeof listIssues> {
    return listIssues(filter, Math.min(Math.max(1, limit), 100), siteId)
  }

  jiraCreateIssue(args: JiraCreateIssueArgs): ReturnType<typeof createIssue> {
    return createIssue(args)
  }

  jiraGetIssue(key: string, siteId?: string): ReturnType<typeof getIssue> {
    return getIssue(key, siteId)
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

  jiraIssueComments(key: string, siteId?: string): ReturnType<typeof getIssueComments> {
    return getIssueComments(key, siteId)
  }

  jiraListProjects(siteId?: JiraSiteSelection): ReturnType<typeof listProjects> {
    return listProjects(siteId)
  }

  jiraListIssueTypes(projectIdOrKey: string, siteId?: string): ReturnType<typeof listIssueTypes> {
    return listIssueTypes(projectIdOrKey, siteId)
  }

  jiraListCreateFields(
    projectIdOrKey: string,
    issueTypeId: string,
    siteId?: string
  ): ReturnType<typeof listCreateFields> {
    return listCreateFields(projectIdOrKey, issueTypeId, siteId)
  }

  jiraListPriorities(siteId?: string): ReturnType<typeof listPriorities> {
    return listPriorities(siteId)
  }

  jiraListAssignableUsers(
    key: string,
    query?: string,
    siteId?: string
  ): ReturnType<typeof listAssignableUsers> {
    return listAssignableUsers(key, query, siteId)
  }

  /** Searches all users on the site, for reporter and user-picker create fields. */
  jiraSearchUsers(query?: string, siteId?: string): ReturnType<typeof searchUsers> {
    return searchUsers(query, siteId)
  }

  jiraListTransitions(key: string, siteId?: string): ReturnType<typeof listTransitions> {
    return listTransitions(key, siteId)
  }

  jiraGetProjectStatusOrder(
    projectKey: string,
    siteId?: string
  ): ReturnType<typeof getProjectStatusOrder> {
    return getProjectStatusOrder(projectKey, siteId)
  }
}
