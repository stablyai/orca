import type {
  MobileWebTaskGitHubCountPayload,
  MobileWebTaskGitHubListPayload,
  MobileWebTaskGitHubListResult,
  MobileWebTaskGitLabListPayload,
  MobileWebTaskGitLabListResult,
  MobileWebTaskGitLabTodo,
  MobileWebTaskLinearIssue,
  MobileWebTaskLinearListPayload
} from '../../../src/shared/mobile-web/task-list-contract'

export type HostTaskListOperations = {
  listGitHub(payload: MobileWebTaskGitHubListPayload): Promise<MobileWebTaskGitHubListResult>
  countGitHub(payload: MobileWebTaskGitHubCountPayload): Promise<number>
  listGitLab(payload: MobileWebTaskGitLabListPayload): Promise<MobileWebTaskGitLabListResult>
  listGitLabTodos(repoId: string): Promise<MobileWebTaskGitLabTodo[]>
  listLinear(payload: MobileWebTaskLinearListPayload): Promise<MobileWebTaskLinearIssue[]>
}
