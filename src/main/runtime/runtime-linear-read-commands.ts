import {
  clampLinearSearchLimit,
  clampLinearIssueListLimit,
  listLinearIssues,
  sanitizeLinearErrorMessage,
  listMcpIssues,
  getLinearTeamMembersOrThrow,
  listLinearTeamsForAgent
} from './runtime-linear-command-dependencies'
import type {
  LinearIssueListFilter,
  LinearIssueListResult,
  LinearProjectListResult,
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearContextCommands } from './runtime-linear-context-commands'
import { linearPriorityLabel } from '../../shared/linear/priority-label'

export class RuntimeLinearReadCommands extends RuntimeLinearContextCommands {
  async linearTeamListForAgents(params: {
    workspaceId?: (string & {}) | 'all'
  }): Promise<LinearTeamListResult> {
    try {
      const result = await listLinearTeamsForAgent(params.workspaceId)
      const workspaceErrors = result.errors.map((error) => ({
        workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
        code: this.linearWorkspaceErrorCode(error.type),
        message: sanitizeLinearErrorMessage(error.message)
      }))
      return {
        teams: result.teams.map((team) => this.linearTeamSummary(team)),
        meta: {
          workspaceId: params.workspaceId,
          returned: result.teams.length,
          partial: workspaceErrors.length > 0,
          workspaceErrors
        }
      }
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  async linearTeamMembersForAgents(params: {
    teamInput: string
    workspaceId?: string
  }): Promise<LinearTeamMembersResult> {
    const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
    try {
      const members = await getLinearTeamMembersOrThrow(team.id, team.workspaceId)
      return {
        team: this.linearTeamSummary(team),
        members: members.map((member) => ({
          id: member.id,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl
        })),
        meta: { workspaceId: team.workspaceId, returned: members.length }
      }
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  async linearTeamStatesForAgents(params: {
    teamInput: string
    workspaceId?: string
  }): Promise<LinearTeamStatesResult> {
    const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
    const states = await this.getLinearTeamStatesForWrite(team.id, team.workspaceId)
    return {
      team: this.linearTeamSummary(team),
      states: states.map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position
      })),
      meta: { workspaceId: team.workspaceId, returned: states.length }
    }
  }

  async linearTeamLabelsForAgents(params: {
    teamInput: string
    workspaceId?: string
  }): Promise<LinearTeamLabelsResult> {
    const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
    const labels = await this.getLinearTeamLabelsForWrite(team.id, team.workspaceId)
    return {
      team: this.linearTeamSummary(team),
      labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
      meta: { workspaceId: team.workspaceId, returned: labels.length }
    }
  }

  async linearProjectListForAgents(params: {
    query?: string
    limit?: number
    workspaceId?: (string & {}) | 'all'
  }): Promise<LinearProjectListResult> {
    const limit = clampLinearSearchLimit(params.limit)
    try {
      const result = await this.linearListProjects(params.query, limit, params.workspaceId, true)
      const projects = result.items.slice(0, limit).map((project) => ({
        id: project.id,
        name: project.name,
        ...(project.url ? { url: project.url } : {}),
        ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
        ...(project.workspaceName ? { workspaceName: project.workspaceName } : {}),
        ...(project.teams ? { teams: project.teams } : {})
      }))
      const workspaceErrors = (result.errors ?? []).map((error) => ({
        workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
        code: this.linearWorkspaceErrorCode(error.type),
        message: sanitizeLinearErrorMessage(error.message)
      }))
      const hasMore = result.hasMore === true || result.items.length > limit
      return {
        projects,
        truncated: hasMore,
        meta: {
          query: params.query,
          workspaceId: params.workspaceId,
          limit,
          returned: projects.length,
          hasMore,
          partial: workspaceErrors.length > 0,
          workspaceErrors
        }
      }
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  async linearIssueListForAgents(params: {
    filter?: LinearIssueListFilter
    teamInput?: string
    limit?: number
    workspaceId?: (string & {}) | 'all'
  }): Promise<LinearIssueListResult> {
    const filter = params.filter ?? 'assigned'
    const limit = clampLinearIssueListLimit(params.limit)
    const team = params.teamInput
      ? await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
      : null
    const workspaceId = team?.workspaceId ?? params.workspaceId
    try {
      const result = await listLinearIssues(filter, limit, workspaceId, {
        teamId: team?.id
      })
      return {
        issues: result.items.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: issue.state,
          team: issue.team,
          project: issue.project ?? null,
          assignee: issue.assignee ?? null,
          priority: issue.priority,
          priorityLabel: linearPriorityLabel(issue.priority),
          estimate: issue.estimate,
          dueDate: issue.dueDate,
          updatedAt: issue.updatedAt,
          workspace: {
            id: issue.workspaceId ?? workspaceId ?? '',
            name: issue.workspaceName ?? issue.workspaceId ?? workspaceId ?? ''
          }
        })),
        truncated: result.hasMore === true,
        meta: {
          filter,
          workspaceId,
          ...(team ? { team: this.linearTeamSummary(team) } : {}),
          limit,
          returned: result.items.length,
          hasMore: result.hasMore === true,
          partial: (result.errors?.length ?? 0) > 0,
          workspaceErrors: (result.errors ?? []).map((error) => ({
            workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
            code: this.linearWorkspaceErrorCode(error.type),
            message: sanitizeLinearErrorMessage(error.message)
          }))
        }
      }
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  async linearMcpIssueList(params: LinearMcpIssueListRequest): Promise<LinearMcpIssueListResult> {
    try {
      return await listMcpIssues(params)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
