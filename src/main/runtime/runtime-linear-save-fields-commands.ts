import {
  type getLinearIssueByUuidForAgent,
  type LinearIssueUpdate,
  type LinearCreateFieldIntent,
  linearError,
  sameStringSet
} from './runtime-linear-command-dependencies'
import { RuntimeLinearTaskFieldCommands } from './runtime-linear-task-fields-commands'

export class RuntimeLinearSaveFieldCommands extends RuntimeLinearTaskFieldCommands {
  public linearSavedIssueMatchesIntent(
    issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    fields: LinearIssueUpdate
  ): boolean {
    if (fields.title !== undefined && issue.title !== fields.title) {
      return false
    }
    if (fields.description !== undefined && (issue.description ?? '') !== fields.description) {
      return false
    }
    if (fields.parentId !== undefined && (issue.parent?.id ?? null) !== fields.parentId) {
      return false
    }
    if (fields.stateId !== undefined && issue.state?.id !== fields.stateId) {
      return false
    }
    if (fields.assigneeId !== undefined && (issue.assignee?.id ?? null) !== fields.assigneeId) {
      return false
    }
    if (fields.priority !== undefined && issue.priority !== fields.priority) {
      return false
    }
    if (fields.estimate !== undefined && (issue.estimate ?? null) !== fields.estimate) {
      return false
    }
    if (fields.dueDate !== undefined && (issue.dueDate ?? null) !== fields.dueDate) {
      return false
    }
    if (fields.projectId !== undefined && (issue.project?.id ?? null) !== fields.projectId) {
      return false
    }
    const issueLabelIds = issue.labelIds ?? issue.labels?.map((label) => label.id) ?? []
    return fields.labelIds === undefined || sameStringSet(issueLabelIds, fields.labelIds)
  }

  public async resolveLinearCreateFields(
    params: {
      state?: string
      assignee?: string
      priority?: number
      estimate?: number
      dueDate?: string
      labels?: string[]
      projectInput?: string
    },
    team: { id: string; workspaceId: string }
  ): Promise<LinearCreateFieldIntent> {
    const fields: LinearCreateFieldIntent = {}
    if (params.state) {
      const states = await this.getLinearTeamStatesForWrite(team.id, team.workspaceId)
      const state = this.resolveLinearAgentState(params.state, states)
      if (!state) {
        throw linearError(
          'linear_invalid_state',
          `No workflow state exactly matched "${params.state}".`,
          { states: states.map(({ id, name, type }) => ({ id, name, type })) }
        )
      }
      fields.stateId = state.id
    }
    if (params.assignee) {
      fields.assigneeId = await this.resolveLinearAssignee(
        params.assignee,
        team.id,
        team.workspaceId
      )
    }
    if (params.priority !== undefined) {
      fields.priority = params.priority
    }
    if (params.estimate !== undefined) {
      fields.estimate = params.estimate
    }
    if (params.dueDate !== undefined) {
      fields.dueDate = params.dueDate
    }
    if (params.labels && params.labels.length > 0) {
      const labels = await this.resolveLinearLabelsForTeam(team.id, params.labels, team.workspaceId)
      fields.labelIds = labels.map((label) => label.id)
    }
    if (params.projectInput) {
      const project = await this.resolveLinearCreateProject(params.projectInput, team)
      fields.projectId = project.id
    }
    return fields
  }
}
