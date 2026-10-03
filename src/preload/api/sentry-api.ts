import type {
  SentryAssignee,
  SentryConnectionStatus,
  SentryEnvironment,
  SentryEvent,
  SentryIssue,
  SentryIssueQuery,
  SentryIssueUpdate,
  SentryMutationResult,
  SentryPage,
  SentryProject
} from '../../shared/sentry-types'

export type SentryApi = {
  connect: (args: {
    baseUrl: string
    token: string
    organizationSlug?: string
  }) => Promise<{ ok: true; status: SentryConnectionStatus } | { ok: false; error: string }>
  disconnect: () => Promise<void>
  selectOrganization: (args: { slug: string }) => Promise<SentryConnectionStatus>
  status: () => Promise<SentryConnectionStatus>
  testConnection: () => Promise<
    { ok: true; status: SentryConnectionStatus } | { ok: false; error: string }
  >
  listProjects: () => Promise<SentryProject[]>
  listEnvironments: () => Promise<SentryEnvironment[]>
  listAssignees: () => Promise<SentryAssignee[]>
  listIssues: (args?: SentryIssueQuery) => Promise<SentryPage<SentryIssue>>
  getIssue: (args: { issueId: string }) => Promise<SentryIssue | null>
  listEvents: (args: { issueId: string; cursor?: string }) => Promise<SentryPage<SentryEvent>>
  updateIssue: (args: {
    issueId: string
    updates: SentryIssueUpdate
  }) => Promise<SentryMutationResult>
}
