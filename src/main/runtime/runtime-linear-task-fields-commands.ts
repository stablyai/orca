import {
  getLinearTeamMembersOrThrow,
  isLinearUuid,
  getLinearIssueByUuidForAgent,
  linearError,
  readLinearIssueContext,
  getLinearTeamStatesOrThrow,
  labelsForIds
} from './runtime-linear-command-dependencies'
import type {
  LinearIssueTaskUpdateRequest,
  LinearSaveIssueRequest,
  LinearIssueUpdate,
  LinearCurrentIssueContextHints,
  LinearAgentWriteTarget
} from './runtime-linear-command-dependencies'
import { RuntimeLinearLabelWriteCommands } from './runtime-linear-label-write-commands'

export class RuntimeLinearTaskFieldCommands extends RuntimeLinearLabelWriteCommands {
  public async getLinearTeamStatesForWrite(
    teamId: string,
    workspaceId: string
  ): Promise<Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>> {
    try {
      return await getLinearTeamStatesOrThrow(teamId, workspaceId)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public resolveLinearAgentState(
    input: string,
    states: Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>
  ): Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>[number] | null {
    const normalized = input.toLocaleLowerCase()
    const exact = states.find(
      (state) =>
        state.id.toLocaleLowerCase() === normalized || state.name.toLocaleLowerCase() === normalized
    )
    // Why: Linear MCP accepts lifecycle types; keep explicit IDs/names authoritative when they collide.
    return exact ?? states.find((state) => state.type.toLocaleLowerCase() === normalized) ?? null
  }

  public async readLinearAgentIssueWriteRecord(
    issueId: string,
    workspaceId: string
  ): Promise<NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>> {
    const issue = await this.readLinearWriteLookup(() =>
      getLinearIssueByUuidForAgent(issueId, workspaceId)
    )
    if (!issue) {
      throw linearError('linear_issue_not_found', 'Linear issue was not found.')
    }
    return issue
  }

  public async buildLinearTaskUpdate(
    params: LinearIssueTaskUpdateRequest,
    current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    workspaceId: string
  ): Promise<{
    fields: {
      assigneeId?: string | null
      priority?: number
      estimate?: number | null
      dueDate?: string | null
      labelIds?: string[]
    }
    labels?: { id: string; name: string }[]
  } | null> {
    if (params.operation === 'assignee') {
      const assigneeId = params.assigneeMe
        ? (await this.getLinearViewerForWrite(workspaceId)).id
        : params.assigneeId
      if (assigneeId === undefined) {
        throw linearError('linear_invalid_assignee', 'Pass --me, --to-id, or clear assignee.')
      }
      return { fields: { assigneeId } }
    }
    if (params.operation === 'priority') {
      if (params.priority === undefined) {
        throw linearError('linear_write_failed', 'Missing priority value.')
      }
      return { fields: { priority: params.priority } }
    }
    if (params.operation === 'estimate') {
      if (params.estimate === undefined) {
        throw linearError('linear_write_failed', 'Missing estimate value.')
      }
      return { fields: { estimate: params.estimate } }
    }
    if (params.operation === 'dueDate') {
      if (params.dueDate === undefined) {
        throw linearError('linear_write_failed', 'Missing due date value.')
      }
      return { fields: { dueDate: params.dueDate } }
    }
    if (params.operation === 'labels') {
      const mode = params.labelMode
      const inputs = params.labels ?? []
      if (!mode || inputs.length === 0) {
        throw linearError('linear_invalid_label', 'Pass at least one --label.')
      }
      const labels = await this.resolveLinearLabelsForIssue(current, inputs, workspaceId)
      const requestedIds = labels.map((label) => label.id)
      const existingIds = current.labelIds ?? current.labels?.map((label) => label.id) ?? []
      const nextIds =
        mode === 'set'
          ? requestedIds
          : mode === 'add'
            ? Array.from(new Set([...existingIds, ...requestedIds]))
            : existingIds.filter((id) => !requestedIds.includes(id))
      return {
        fields: { labelIds: nextIds },
        labels: labelsForIds(nextIds, [...(current.labels ?? []), ...labels])
      }
    }
    return null
  }

  public async buildLinearSaveUpdate(
    params: LinearSaveIssueRequest,
    current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    workspaceId: string
  ): Promise<LinearIssueUpdate> {
    const fields: LinearIssueUpdate = {}
    if (params.title !== undefined) {
      fields.title = params.title
    }
    if (params.description !== undefined) {
      fields.description = params.description
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
    if (params.state !== undefined) {
      const states = await this.getLinearTeamStatesForWrite(current.team.id, workspaceId)
      const state = this.resolveLinearAgentState(params.state, states)
      if (!state) {
        throw linearError(
          'linear_invalid_state',
          `No workflow state exactly matched "${params.state}".`
        )
      }
      fields.stateId = state.id
    }
    if (params.assignee !== undefined) {
      fields.assigneeId =
        params.assignee === null
          ? null
          : await this.resolveLinearAssignee(params.assignee, current.team.id, workspaceId)
    }
    if (params.labels !== undefined) {
      if (params.labels.length === 0) {
        fields.labelIds = []
      } else {
        const labels = await this.resolveLinearLabelsForIssue(current, params.labels, workspaceId)
        fields.labelIds = labels.map((label) => label.id)
      }
    }
    if (params.project !== undefined) {
      fields.projectId =
        params.project === null
          ? null
          : (
              await this.resolveLinearCreateProject(params.project, {
                id: current.team.id,
                workspaceId
              })
            ).id
    }
    if (params.parentId !== undefined) {
      fields.parentId =
        params.parentId === null
          ? null
          : (
              await this.resolveLinearAgentWriteTarget({
                input: params.parentId,
                workspaceId,
                context: params.context
              })
            ).issue.id
      if (fields.parentId === current.id) {
        throw linearError('linear_invalid_parent', 'An issue cannot be its own parent.')
      }
    }
    return fields
  }
  public async resolveLinearAssignee(
    input: string,
    teamId: string,
    workspaceId: string
  ): Promise<string> {
    if (input.toLocaleLowerCase() === 'me') {
      return (await this.getLinearViewerForWrite(workspaceId)).id
    }
    // Why: caller-supplied IDs were accepted directly before save-issue; avoid a paginated member scan on that existing fast path.
    if (isLinearUuid(input)) {
      return input
    }
    let members: Awaited<ReturnType<typeof getLinearTeamMembersOrThrow>>
    try {
      members = await getLinearTeamMembersOrThrow(teamId, workspaceId)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
    const normalized = input.toLocaleLowerCase()
    const matches = members.filter(
      (member) =>
        member.id.toLocaleLowerCase() === normalized ||
        member.displayName.toLocaleLowerCase() === normalized ||
        member.name?.toLocaleLowerCase() === normalized ||
        member.email?.toLocaleLowerCase() === normalized
    )
    if (matches.length === 1) {
      return matches[0].id
    }
    throw linearError(
      'linear_invalid_assignee',
      matches.length === 0
        ? `No team member exactly matched "${input}".`
        : `Multiple team members exactly matched "${input}".`
    )
  }
  public async resolveLinearAgentWriteTarget(params: {
    input?: string
    current?: boolean
    workspaceId?: string
    context?: LinearCurrentIssueContextHints
  }): Promise<LinearAgentWriteTarget> {
    const result = await readLinearIssueContext(
      {
        input: params.input,
        current: params.current,
        workspaceId: params.workspaceId,
        include: {
          comments: false,
          children: false,
          attachments: false,
          relations: false,
          activity: false
        },
        depth: 0,
        context: params.context
      },
      (context) => this.linearResolveCurrentIssue(context)
    )
    return { issue: result.issue, workspaceId: result.meta.resolved.workspaceId }
  }
}
