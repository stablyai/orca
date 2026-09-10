import type {
  HostTaskGitHubCountPayload,
  HostTaskGitHubListPayload,
  HostTaskGitHubListResult,
  HostTaskGitLabListPayload,
  HostTaskGitLabListResult,
  HostTaskLinearListPayload
} from './host-task-provider-payloads'
import type { GitLabTodo, LinearIssue } from './mobile-tasks-provider-detail-types'

export type HostTaskListOperations = {
  listGitHub(payload: HostTaskGitHubListPayload): Promise<HostTaskGitHubListResult>
  countGitHub(payload: HostTaskGitHubCountPayload): Promise<number>
  listGitLab(payload: HostTaskGitLabListPayload): Promise<HostTaskGitLabListResult>
  listGitLabTodos(repoId: string): Promise<GitLabTodo[]>
  listLinear(payload: HostTaskLinearListPayload): Promise<LinearIssue[]>
}
