import type { MobileWebTaskLinearIssue } from '../../../src/shared/mobile-web/task-list-contract'
import type {
  MobileWebTaskLinearCreatedIssue,
  MobileWebTaskLinearState,
  MobileWebTaskLinearTeam
} from '../../../src/shared/mobile-web/task-linear-contract'

export type HostTaskLinearTarget = {
  issueId: string
  workspaceId?: string
  teamId: string
  projectId?: string
  targetId?: string
}

export type HostTaskLinearOperations = {
  connect(apiKey: string): Promise<void>
  listTeams(): Promise<MobileWebTaskLinearTeam[]>
  teamStates(target: HostTaskLinearTarget): Promise<MobileWebTaskLinearState[]>
  selectWorkspace(workspaceId: string): Promise<void>
  updateState(target: HostTaskLinearTarget, stateId: string): Promise<void>
  addComment(target: HostTaskLinearTarget, body: string): Promise<string | undefined>
  loadIssue(target: HostTaskLinearTarget): Promise<MobileWebTaskLinearIssue>
  createSubIssue(
    target: HostTaskLinearTarget,
    title: string
  ): Promise<MobileWebTaskLinearCreatedIssue>
  createIssue(payload: {
    team: MobileWebTaskLinearTeam
    title: string
    description?: string
  }): Promise<MobileWebTaskLinearCreatedIssue>
}
