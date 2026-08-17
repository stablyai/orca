import type { LinearProjectTeamRef } from '../../shared/linear/project-agent-access'
import { linearError, type LinearAgentAccessError } from './issue-context-errors'
import { resolveWorkspaceTeamsInEntry } from './project-write-actors'
import { selectLinearProjectWorkspaces } from './project-workspace-scope'

const CREATE_ACTION = 'a project create'
const TEAMS_STEP = 'Run `orca linear teams --json` and retry with team keys from one workspace.'

export type LinearProjectCreateScope = {
  workspaceId: string
  workspaceName: string
  teams: LinearProjectTeamRef[]
}

/**
 * Every repeated `--team` must resolve in ONE workspace. Unscoped, exactly one
 * connected workspace has to resolve the complete set; anything else fails closed.
 */
export async function resolveProjectCreateScope(
  teamInputs: string[],
  workspaceId: string | undefined,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectCreateScope> {
  if (teamInputs.length === 0) {
    throw linearError('linear_team_required', 'Pass at least one --team for a project create.', {
      nextSteps: [TEAMS_STEP]
    })
  }
  const entries = selectLinearProjectWorkspaces(workspaceId, CREATE_ACTION)
  if (entries.length === 1) {
    return {
      workspaceId: entries[0].workspace.id,
      workspaceName: entries[0].workspace.organizationName,
      teams: await resolveWorkspaceTeamsInEntry(entries[0], teamInputs, options.signal)
    }
  }

  const scopes: LinearProjectCreateScope[] = []
  for (const entry of entries) {
    // Why: an unmatched team only disqualifies this workspace; any other failure
    // means the fan-out cannot prove uniqueness, so it propagates.
    try {
      scopes.push({
        workspaceId: entry.workspace.id,
        workspaceName: entry.workspace.organizationName,
        teams: await resolveWorkspaceTeamsInEntry(entry, teamInputs, options.signal)
      })
    } catch (error) {
      if (!isUnresolvedTeamError(error)) {
        throw error
      }
    }
  }
  if (scopes.length === 1) {
    return scopes[0]
  }
  throw scopeError(scopes, teamInputs)
}

function isUnresolvedTeamError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'linear_team_required'
  )
}

function scopeError(
  scopes: LinearProjectCreateScope[],
  teamInputs: string[]
): LinearAgentAccessError {
  const inputs = teamInputs.join(', ')
  if (scopes.length === 0) {
    return linearError(
      'linear_team_required',
      `No connected Linear workspace resolved every team (${inputs}).`,
      { nextSteps: [TEAMS_STEP] }
    )
  }
  return linearError(
    'linear_invalid_workspace',
    `More than one connected Linear workspace resolved every team (${inputs}).`,
    {
      candidates: scopes.map((scope) => ({ id: scope.workspaceId, name: scope.workspaceName })),
      nextSteps: scopes.map((scope) => `Retry with --workspace ${scope.workspaceId}.`)
    }
  )
}
