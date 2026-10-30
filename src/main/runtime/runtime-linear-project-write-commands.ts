import {
  LINEAR_SEARCH_MAX_LIMIT,
  isLinearUuid,
  getLinearProject,
  listLinearProjectsByExactName,
  listLinearProjectTeams,
  listLinearProjects,
  getLinearViewerForWorkspaceOrThrow
} from './runtime-linear-command-dependencies'
import { linearError } from '../linear/issue-context/errors'
import type { LinearProjectSummary } from './runtime-linear-command-dependencies'
import { RuntimeLinearTeamWriteCommands } from './runtime-linear-team-write-commands'

export class RuntimeLinearProjectWriteCommands extends RuntimeLinearTeamWriteCommands {
  public async resolveLinearCreateProject(
    input: string,
    team: { id: string; workspaceId: string },
    signal?: AbortSignal
  ): Promise<LinearProjectSummary> {
    signal?.throwIfAborted()
    const trimmed = input.trim()
    if (!trimmed) {
      throw linearError('linear_invalid_project', 'Pass a non-empty Linear project id or name.')
    }
    const byId = isLinearUuid(trimmed)
      ? await this.readLinearProjectByIdForCreate(trimmed, team.workspaceId, signal)
      : null
    if (byId) {
      await this.assertLinearProjectIncludesTeam(byId, team.id, team.workspaceId, trimmed, signal)
      return byId
    }
    const searchCandidates = await this.readLinearProjectsForCreate(
      trimmed,
      team.workspaceId,
      signal
    )
    const normalized = trimmed.toLowerCase()
    const idMatch = searchCandidates.find((project) => project.id.toLowerCase() === normalized)
    if (idMatch) {
      await this.assertLinearProjectIncludesTeam(
        idMatch,
        team.id,
        team.workspaceId,
        trimmed,
        signal
      )
      return idMatch
    }
    const slugMatch = searchCandidates.find(
      (project) => project.slugId?.toLowerCase() === normalized
    )
    if (slugMatch) {
      await this.assertLinearProjectIncludesTeam(
        slugMatch,
        team.id,
        team.workspaceId,
        trimmed,
        signal
      )
      return slugMatch
    }
    const nameMatches = await this.readLinearProjectsByExactNameForCreate(
      trimmed,
      team.workspaceId,
      signal
    )
    const compatibleNameMatches = await this.filterLinearProjectsForTeam(
      nameMatches,
      team.id,
      team.workspaceId,
      signal
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
      await this.assertLinearProjectIncludesTeam(
        nameMatches[0],
        team.id,
        team.workspaceId,
        trimmed,
        signal
      )
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
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<LinearProjectSummary | null> {
    signal?.throwIfAborted()
    try {
      return await getLinearProject(id, workspaceId, true, signal)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async readLinearProjectsForCreate(
    query: string,
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<LinearProjectSummary[]> {
    signal?.throwIfAborted()
    try {
      return (await listLinearProjects(query, LINEAR_SEARCH_MAX_LIMIT, workspaceId, true, signal))
        .items
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async readLinearProjectsByExactNameForCreate(
    name: string,
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<LinearProjectSummary[]> {
    signal?.throwIfAborted()
    try {
      return await listLinearProjectsByExactName(name, workspaceId, true, signal)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }

  public async assertLinearProjectIncludesTeam(
    project: LinearProjectSummary,
    teamId: string,
    workspaceId: string,
    input: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    if (this.linearProjectIncludesTeam(project, teamId)) {
      return
    }
    let teams: NonNullable<LinearProjectSummary['teams']> = []
    try {
      // Summary team lists are capped; page membership before refusing cross-team creates.
      teams = await listLinearProjectTeams(project.id, workspaceId, true, signal)
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
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<LinearProjectSummary[]> {
    signal?.throwIfAborted()
    const compatible: LinearProjectSummary[] = []
    for (const project of projects) {
      if (this.linearProjectIncludesTeam(project, teamId)) {
        compatible.push(project)
        continue
      }
      try {
        const teams = await listLinearProjectTeams(project.id, workspaceId, true, signal)
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
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
    signal?.throwIfAborted()
    try {
      return await getLinearViewerForWorkspaceOrThrow(workspaceId, signal)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
