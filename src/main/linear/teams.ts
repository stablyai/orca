import type { Team } from '@linear/sdk'
import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/types'
import { acquire, release, getClients, isAuthError, clearToken } from './client'
import {
  fetchAllTeamLabels,
  fetchAllTeamMembers,
  fetchAllTeamsForWorkspace,
  fetchAllTeamStates
} from './linear-team-pages'

export async function listTeams(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return fetchAllTeamsForWorkspace(entry)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (workspaceId !== 'all') {
            throw error
          }
        } else {
          console.warn('[linear] listTeams failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTeamsOrThrow(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return await fetchAllTeamsForWorkspace(entry)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTeamsForAgent(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<{ teams: LinearTeam[]; errors: LinearWorkspaceError[] }> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { teams: [], errors: [] }
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return { teams: await fetchAllTeamsForWorkspace(entry), error: null }
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        return {
          teams: [],
          error: {
            workspaceId: entry.workspace.id,
            workspaceName: entry.workspace.organizationName,
            type: isAuthError(error) ? 'auth' : 'unknown',
            message: error instanceof Error ? error.message : String(error)
          } satisfies LinearWorkspaceError
        }
      } finally {
        release()
      }
    })
  )
  return {
    teams: results.flatMap((result) => result.teams).sort((a, b) => a.name.localeCompare(b.name)),
    errors: results.flatMap((result) => (result.error ? [result.error] : []))
  }
}

async function readTeamResource<T>(
  teamId: string,
  workspaceId: string | null | undefined,
  fetchAll: (team: Team) => Promise<T[]>,
  fallbackWarning?: string
): Promise<T[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    return await fetchAll(await entry.client.team(teamId))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    if (!fallbackWarning) {
      throw error
    }
    console.warn(`[linear] ${fallbackWarning} failed:`, error)
    return []
  } finally {
    release()
  }
}

export async function getTeamStates(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamStates, 'getTeamStates')
}

export async function getTeamStatesOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamStates)
}

export async function getTeamLabels(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamLabels, 'getTeamLabels')
}

export async function getTeamLabelsOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamLabels)
}

export async function getTeamMembers(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamMembers, 'getTeamMembers')
}

export async function getTeamMembersOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  return readTeamResource(teamId, workspaceId, fetchAllTeamMembers)
}

export async function getViewerForWorkspaceOrThrow(
  workspaceId: string
): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new Error('Not connected to Linear')
  }

  await acquire()
  try {
    const viewer = await entry.client.viewer
    return {
      id: viewer.id,
      displayName: viewer.displayName,
      avatarUrl: viewer.avatarUrl ?? undefined
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}
