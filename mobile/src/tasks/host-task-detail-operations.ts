import type {
  HostTaskGitHubDetail,
  HostTaskGitHubDetailPayload,
  HostTaskGitLabDetail,
  HostTaskLinearDetail
} from './host-task-provider-payloads'
import type { GitHubAssignableUser } from './mobile-tasks-provider-detail-types'

export type HostTaskGitLabDetailPayload = {
  repoId: string
  number: number
  type: 'issue' | 'mr'
  projectRef?: { host: string; path: string }
}

export type HostTaskLinearDetailPayload = {
  issueId: string
  workspaceId?: string
}

export type HostTaskDetailOperations = {
  listGitHubLabels(repoId: string): Promise<string[]>
  listGitHubAssignableUsers(repoId: string): Promise<GitHubAssignableUser[]>
  loadGitHub(payload: HostTaskGitHubDetailPayload): Promise<HostTaskGitHubDetail>
  loadGitLab(payload: HostTaskGitLabDetailPayload): Promise<HostTaskGitLabDetail>
  loadLinear(payload: HostTaskLinearDetailPayload): Promise<HostTaskLinearDetail>
}
