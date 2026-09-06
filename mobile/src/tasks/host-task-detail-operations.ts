import type {
  MobileWebTaskGitHubDetailPayload,
  MobileWebTaskGitHubDetailResult,
  MobileWebTaskGitHubUser,
  MobileWebTaskGitLabDetailResult,
  MobileWebTaskLinearDetailResult
} from '../../../src/shared/mobile-web/task-detail-contract'

export type HostTaskGitLabDetailPayload = {
  repoId: string
  number: number
  type: 'issue' | 'mr'
  projectRef?: { host: string; path: string }
  targetId?: string
}

export type HostTaskLinearDetailPayload = {
  issueId: string
  workspaceId?: string
  targetId?: string
}

export type HostTaskDetailOperations = {
  listGitHubLabels(repoId: string): Promise<string[]>
  listGitHubAssignableUsers(repoId: string): Promise<MobileWebTaskGitHubUser[]>
  loadGitHub(payload: MobileWebTaskGitHubDetailPayload): Promise<MobileWebTaskGitHubDetailResult>
  loadGitLab(payload: HostTaskGitLabDetailPayload): Promise<MobileWebTaskGitLabDetailResult>
  loadLinear(payload: HostTaskLinearDetailPayload): Promise<MobileWebTaskLinearDetailResult>
}
