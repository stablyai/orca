import type { GitHubProjectRef, GitHubProjectViewSummary } from './github-project-reference'
import type {
  HostTaskProjectAssignableUsersPayload,
  HostTaskProjectIssueType,
  HostTaskProjectItemDetailPayload,
  HostTaskProjectListResult,
  HostTaskProjectResolvePayload,
  HostTaskProjectResolveResult,
  HostTaskProjectSlugPayload,
  HostTaskProjectTablePayload
} from './host-task-project-payloads'
import type { HostTaskGitHubDetail } from './host-task-provider-payloads'
import type { GitHubAssignableUser } from './mobile-tasks-provider-detail-types'
import type { GitHubProjectTable } from './mobile-tasks-view-state-types'

export type HostTaskProjectReadOperations = {
  listAccessible(host: string): Promise<HostTaskProjectListResult>
  listViews(project: GitHubProjectRef): Promise<GitHubProjectViewSummary[]>
  resolveRef(payload: HostTaskProjectResolvePayload): Promise<HostTaskProjectResolveResult>
  loadTable(payload: HostTaskProjectTablePayload): Promise<GitHubProjectTable>
  loadItemDetail(payload: HostTaskProjectItemDetailPayload): Promise<HostTaskGitHubDetail>
  listItemLabels(payload: HostTaskProjectSlugPayload): Promise<string[]>
  listItemAssignableUsers(
    payload: HostTaskProjectAssignableUsersPayload
  ): Promise<GitHubAssignableUser[]>
  listIssueTypes(payload: HostTaskProjectSlugPayload): Promise<HostTaskProjectIssueType[]>
}
