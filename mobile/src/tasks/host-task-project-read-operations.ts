import type {
  MobileWebTaskProjectListResult,
  MobileWebTaskProjectRef,
  MobileWebTaskProjectResolvePayload,
  MobileWebTaskProjectResolveResult,
  MobileWebTaskProjectView
} from '../../../src/shared/mobile-web/task-project-read-contract'
import type {
  MobileWebTaskProjectTable,
  MobileWebTaskProjectTablePayload
} from '../../../src/shared/mobile-web/task-project-table-contract'
import type {
  MobileWebTaskProjectAssignableUsersPayload,
  MobileWebTaskProjectIssueType,
  MobileWebTaskProjectItemDetailPayload,
  MobileWebTaskProjectSlugPayload
} from '../../../src/shared/mobile-web/task-project-metadata-contract'
import type {
  MobileWebTaskGitHubDetailResult,
  MobileWebTaskGitHubUser
} from '../../../src/shared/mobile-web/task-detail-contract'

export type HostTaskProjectReadOperations = {
  listAccessible(host: string): Promise<MobileWebTaskProjectListResult>
  listViews(project: MobileWebTaskProjectRef): Promise<MobileWebTaskProjectView[]>
  resolveRef(
    payload: MobileWebTaskProjectResolvePayload
  ): Promise<MobileWebTaskProjectResolveResult>
  loadTable(
    payload: Omit<MobileWebTaskProjectTablePayload, 'cursor'>
  ): Promise<MobileWebTaskProjectTable>
  loadItemDetail(
    payload: MobileWebTaskProjectItemDetailPayload
  ): Promise<MobileWebTaskGitHubDetailResult>
  listItemLabels(payload: MobileWebTaskProjectSlugPayload): Promise<string[]>
  listItemAssignableUsers(
    payload: MobileWebTaskProjectAssignableUsersPayload
  ): Promise<MobileWebTaskGitHubUser[]>
  listIssueTypes(payload: MobileWebTaskProjectSlugPayload): Promise<MobileWebTaskProjectIssueType[]>
}
