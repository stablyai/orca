import type {
  RedmineConnectionError,
  RedmineConnectionStatus,
  RedmineIssue,
  RedmineIssueCollectionResult,
  RedmineListFilter,
  RedmineReadError,
  RedmineSite,
  RedmineUser
} from '../../shared/redmine-types'

export type RedmineApi = {
  connect: (args: {
    siteUrl: string
    apiKey: string
  }) => Promise<
    | { ok: true; site: RedmineSite; viewer: RedmineUser }
    | { ok: false; error: RedmineConnectionError }
  >
  disconnect: (args: { siteId: string }) => Promise<void>
  status: () => Promise<RedmineConnectionStatus>
  testConnection: (args: {
    siteUrl: string
    apiKey: string
  }) => Promise<{ ok: true; user: RedmineUser } | { ok: false; error: RedmineConnectionError }>
  listIssues: (args?: { filter?: RedmineListFilter }) => Promise<RedmineIssueCollectionResult>
  getIssue: (args: { issueId: number }) => Promise<{
    issue: RedmineIssue | null
    error?: RedmineReadError
  }>
}
