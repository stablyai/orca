import type { LinearCustomViewModel } from '../../shared/linear/project-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import { getIssueComments } from '../linear/linear-issue-comments'
import {
  createProject,
  getCustomView,
  getProject,
  listCustomViewIssues,
  listCustomViewProjects,
  listCustomViews,
  listProjectIssues,
  listProjects,
  type LinearProjectCreateInput
} from '../linear/projects'
import { getTeamLabels, getTeamMembers, getTeamStates, listTeams } from '../linear/teams'

export class RuntimeLinearBrowseCommands {
  linearIssueComments(issueId: string, workspaceId?: string): ReturnType<typeof getIssueComments> {
    return getIssueComments(issueId, workspaceId)
  }

  linearListTeams(workspaceId?: LinearWorkspaceSelection): ReturnType<typeof listTeams> {
    return listTeams(workspaceId)
  }

  linearListProjects(
    query?: string,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection,
    force?: boolean
  ): ReturnType<typeof listProjects> {
    return listProjects(query, Math.min(Math.max(1, limit), 50), workspaceId, force)
  }

  linearCreateProject(
    input: LinearProjectCreateInput,
    workspaceId?: string
  ): ReturnType<typeof createProject> {
    return createProject(input, workspaceId)
  }

  linearGetProject(
    id: string,
    workspaceId: string,
    force?: boolean
  ): ReturnType<typeof getProject> {
    return getProject(id, workspaceId, force)
  }

  linearListProjectIssues(
    projectId: string,
    limit = 20,
    workspaceId: string,
    force?: boolean
  ): ReturnType<typeof listProjectIssues> {
    return listProjectIssues(projectId, clampLinearIssueListLimit(limit), workspaceId, force)
  }

  linearListCustomViews(
    model: LinearCustomViewModel,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection,
    force?: boolean
  ): ReturnType<typeof listCustomViews> {
    return listCustomViews(model, Math.min(Math.max(1, limit), 50), workspaceId, force)
  }

  linearGetCustomView(
    viewId: string,
    model: LinearCustomViewModel,
    workspaceId: string,
    force?: boolean
  ): ReturnType<typeof getCustomView> {
    return getCustomView(viewId, model, workspaceId, force)
  }

  linearListCustomViewIssues(
    viewId: string,
    limit = 20,
    workspaceId: string,
    force?: boolean
  ): ReturnType<typeof listCustomViewIssues> {
    return listCustomViewIssues(viewId, clampLinearIssueListLimit(limit), workspaceId, force)
  }

  linearListCustomViewProjects(
    viewId: string,
    limit = 20,
    workspaceId: string,
    force?: boolean
  ): ReturnType<typeof listCustomViewProjects> {
    return listCustomViewProjects(viewId, Math.min(Math.max(1, limit), 50), workspaceId, force)
  }

  linearTeamStates(teamId: string, workspaceId?: string): ReturnType<typeof getTeamStates> {
    return getTeamStates(teamId, workspaceId)
  }

  linearTeamLabels(teamId: string, workspaceId?: string): ReturnType<typeof getTeamLabels> {
    return getTeamLabels(teamId, workspaceId)
  }

  linearTeamMembers(teamId: string, workspaceId?: string): ReturnType<typeof getTeamMembers> {
    return getTeamMembers(teamId, workspaceId)
  }
}
