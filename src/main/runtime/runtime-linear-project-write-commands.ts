import {
  LINEAR_SEARCH_MAX_LIMIT,
  isLinearUuid,
  linearError,
  getLinearProject,
  listLinearProjectsByExactName,
  listLinearProjectTeams,
  listLinearProjects,
  getLinearViewerForWorkspaceOrThrow
} from './runtime-linear-command-dependencies'
import type { LinearProjectSummary } from './runtime-linear-command-dependencies'
import { RuntimeLinearTeamWriteCommands } from './runtime-linear-team-write-commands'

export class RuntimeLinearProjectWriteCommands extends RuntimeLinearTeamWriteCommands {
  public async resolveLinearCreateProject(
    input: string,
    team: { id: string; workspaceId: string }
  ): Promise<LinearProjectSummary> {
    const trimmed = input.trim()
    if (!trimmed) {
      throw linearError('linear_invalid_project', 'Pass a non-empty Linear project id or name.')
    }
    const byId = isLinearUuid(trimmed)
      ? await this.readLinearProjectByIdForCreate(trimmed, team.workspaceId)
      : null
    if (byId) {
      await this.assertLinearProjectIncludesTeam(byId, team.id, team.workspaceId, trimmed)
      return byId
    }
    const searchCandidates = await this.readLinearProjectsForCreate(trimmed, team.workspaceId)
    const normalized = trimmed.toLowerCase()
    const idMatch = searchCandidates.find((project) => project.id.toLowerCase() === normalized)
    if (idMatch) {
      await this.assertLinearProjectIncludesTeam(idMatch, team.id, team.workspaceId, trimmed)
      return idMatch
    }
    const slugMatch = searchCandidates.find(
      (project) => project.slugId?.toLowerCase() === normalized
    )
    if (slugMatch) {
      await this.assertLinearProjectIncludesTeam(slugMatch, team.id, team.workspaceId, trimmed)
      return slugMatch
    }
    const nameMatches = await this.readLinearProjectsByExactNameForCreate(trimmed, team.workspaceId)
    const compatibleNameMatches = await this.filterLinearProjectsForTeam(
      nameMatches,
      team.id,
      team.workspaceId
    )
    if (compatibleNameMatches.length === 1) {
      return compatibleNameMatches[0]
    }
    if (compatibleNameMatches.length > 1) {
      throw linearError(
        'linear_invalid_project',
        `Multiple Linear projects exactly matched "${trimmed}".`,
        {
          projects: compatibleNameMatches.map((project) => ({
            id: project.id,
            name: project.name,
            teams: project.teams
          })),
          nextSteps: ['Run `orca linear project list --query <name> --json` and retry by id.']
        }
      )
    }
    if (nameMatches.length > 0) {
      await this.assertLinearProjectIncludesTeam(nameMatches[0], team.id, team.workspaceId, trimmed)
    }
    throw linearError('linear_invalid_project', `No Linear project exactly matched "${trimmed}".`, {
      projects: searchCandidates.map((project) => ({
        id: project.id,
        name: project.name,
        teams: project.teams
      })),
      nextSteps: ['Run `orca linear project list --query <name> --json` and retry by id.']
    })
  }

  public async readLinearProjectByIdForCreate(
    id: string,
    workspaceId: string
  ): Promise<LinearProjectSummary | null> {
    try {
      return await getLinearProject(id, workspaceId, true)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async readLinearProjectsForCreate(
    query: string,
    workspaceId: string
  ): Promise<LinearProjectSummary[]> {
    try {
      return (await listLinearProjects(query, LINEAR_SEARCH_MAX_LIMIT, workspaceId, true)).items
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async readLinearProjectsByExactNameForCreate(
    name: string,
    workspaceId: string
  ): Promise<LinearProjectSummary[]> {
    try {
      return await listLinearProjectsByExactName(name, workspaceId, true)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async assertLinearProjectIncludesTeam(
    project: LinearProjectSummary,
    teamId: string,
    workspaceId: string,
    input: string
  ): Promise<void> {
    if (this.linearProjectIncludesTeam(project, teamId)) {
      return
    }
    let teams: NonNullable<LinearProjectSummary['teams']> = []
    try {
      // Why: summary reads cap project teams, so large cross-team projects need a paged membership check before rejecting a valid create.
      teams = await listLinearProjectTeams(project.id, workspaceId, true)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
    if (teams.some((team) => team.id === teamId)) {
      return
    }
    throw linearError(
      'linear_invalid_project',
      `Linear project "${input}" is not available to the target team.`,
      {
        project: { id: project.id, name: project.name, teams },
        nextSteps: ['Choose a project that includes the create target team, then retry by id.']
      }
    )
  }

  public async filterLinearProjectsForTeam(
    projects: LinearProjectSummary[],
    teamId: string,
    workspaceId: string
  ): Promise<LinearProjectSummary[]> {
    const compatible: LinearProjectSummary[] = []
    for (const project of projects) {
      if (this.linearProjectIncludesTeam(project, teamId)) {
        compatible.push(project)
        continue
      }
      try {
        const teams = await listLinearProjectTeams(project.id, workspaceId, true)
        if (teams.some((team) => team.id === teamId)) {
          compatible.push({ ...project, teams })
        }
      } catch (error) {
        throw this.mapLinearReadFailure(error)
      }
    }
    return compatible
  }

  public linearProjectIncludesTeam(project: LinearProjectSummary, teamId: string): boolean {
    return project.teams?.some((team) => team.id === teamId) === true
  }

  public async getLinearViewerForWrite(
    workspaceId: string
  ): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
    try {
      return await getLinearViewerForWorkspaceOrThrow(workspaceId)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
