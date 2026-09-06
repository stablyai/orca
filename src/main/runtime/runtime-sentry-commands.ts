import type { SentryIssueQuery, SentryIssueUpdate } from '../../shared/sentry-types'
import {
  connectSentry,
  disconnectSentry,
  getSentryIssue,
  getSentryStatus,
  listSentryAssignees,
  listSentryEnvironments,
  listSentryEvents,
  listSentryIssues,
  listSentryProjects,
  selectSentryOrganization,
  testSentryConnection,
  updateSentryIssue
} from '../sentry/service'

export class RuntimeSentryCommands {
  sentryConnect(args: { baseUrl: string; token: string; organizationSlug?: string }) {
    return connectSentry(args)
  }
  sentryDisconnect(): { ok: true } {
    disconnectSentry()
    return { ok: true }
  }
  sentrySelectOrganization(slug: string) {
    return selectSentryOrganization(slug)
  }
  sentryStatus() {
    return getSentryStatus()
  }
  sentryTestConnection() {
    return testSentryConnection()
  }
  sentryListProjects() {
    return listSentryProjects()
  }
  sentryListEnvironments() {
    return listSentryEnvironments()
  }
  sentryListAssignees() {
    return listSentryAssignees()
  }
  sentryListIssues(query: SentryIssueQuery, signal?: AbortSignal) {
    return listSentryIssues(query, signal)
  }
  sentryGetIssue(issueId: string) {
    return getSentryIssue(issueId)
  }
  sentryListEvents(issueId: string, cursor?: string, signal?: AbortSignal) {
    return listSentryEvents(issueId, cursor, signal)
  }
  sentryUpdateIssue(issueId: string, updates: SentryIssueUpdate) {
    return updateSentryIssue(issueId, updates)
  }
}
