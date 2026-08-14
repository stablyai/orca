import type {
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateIssueArgs,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSiteSelection,
  JiraTransition,
  JiraUser,
  JiraViewer
} from '../../shared/jira-types'

export type JiraApi = {
  connect: (args: {
    siteUrl: string
    email: string
    apiToken: string
    authType?: 'cloud' | 'server'
  }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  disconnect: (args?: { siteId?: string }) => Promise<void>
  selectSite: (args: { siteId: JiraSiteSelection }) => Promise<JiraConnectionStatus>
  status: () => Promise<JiraConnectionStatus>
  readStatus: () => Promise<JiraConnectionStatus>
  testConnection: (args?: {
    siteId?: string
  }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  searchIssues: (args: {
    jql: string
    limit?: number
    siteId?: JiraSiteSelection
    requestId?: string
  }) => Promise<JiraIssue[]>
  cancelSearchIssues: (args: { requestId: string }) => Promise<void>
  listIssues: (args?: {
    filter?: JiraIssueFilter
    limit?: number
    siteId?: JiraSiteSelection
  }) => Promise<JiraIssue[]>
  getIssue: (args: { key: string; siteId?: string }) => Promise<JiraIssue | null>
  lookupIssueSummary: (args: {
    key: string
    siteId: string
    requestId?: string
  }) => Promise<JiraIssue | null>
  cancelIssueSummary: (args: { requestId: string }) => Promise<void>
  createIssue: (
    args: JiraCreateIssueArgs
  ) => Promise<{ ok: true; id: string; key: string; url: string } | { ok: false; error: string }>
  updateIssue: (args: {
    key: string
    updates: JiraIssueUpdate
    siteId?: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (args: {
    key: string
    body: string
    siteId?: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  issueComments: (args: { key: string; siteId?: string }) => Promise<JiraComment[]>
  listProjects: (args?: { siteId?: JiraSiteSelection }) => Promise<JiraProject[]>
  listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }) => Promise<JiraIssueType[]>
  listCreateFields: (args: {
    projectIdOrKey: string
    issueTypeId: string
    siteId?: string
  }) => Promise<JiraCreateField[]>
  listPriorities: (args?: { siteId?: string }) => Promise<JiraPriority[]>
  listAssignableUsers: (args: {
    key: string
    query?: string
    siteId?: string
  }) => Promise<JiraUser[]>
  listTransitions: (args: { key: string; siteId?: string }) => Promise<JiraTransition[]>
  getProjectStatusOrder: (args: {
    projectKey: string
    siteId?: string
  }) => Promise<JiraProjectStatusOrder>
}
