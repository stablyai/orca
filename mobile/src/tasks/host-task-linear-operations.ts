import type { HostTaskLinearCreatedIssue } from './host-task-provider-payloads'
import type { LinearIssue, LinearState, LinearTeam } from './mobile-tasks-provider-detail-types'

export type HostTaskLinearTarget = {
  issueId: string
  workspaceId?: string
  teamId: string
  projectId?: string
}

export type HostTaskLinearOperations = {
  connect(apiKey: string): Promise<void>
  listTeams(): Promise<LinearTeam[]>
  teamStates(target: HostTaskLinearTarget): Promise<LinearState[]>
  selectWorkspace(workspaceId: string): Promise<void>
  updateState(target: HostTaskLinearTarget, stateId: string): Promise<void>
  addComment(target: HostTaskLinearTarget, body: string): Promise<string | undefined>
  loadIssue(target: HostTaskLinearTarget): Promise<LinearIssue>
  createSubIssue(target: HostTaskLinearTarget, title: string): Promise<HostTaskLinearCreatedIssue>
  createIssue(payload: {
    team: LinearTeam
    title: string
    description?: string
  }): Promise<HostTaskLinearCreatedIssue>
}
