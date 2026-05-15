import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearWorkspaceSelection
} from '../../shared/types'
import { acquire, release, getClients, isAuthError, clearToken } from './client'

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
        const teams = await entry.client.teams()
        return teams.nodes.map((t) => ({
          id: t.id,
          workspaceId: entry.workspace.id,
          workspaceName: entry.workspace.organizationName,
          name: t.name,
          key: t.key
        }))
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

export async function getTeamStates(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    const states = await team.states()
    return states.nodes
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        color: s.color,
        position: s.position
      }))
      .sort((a, b) => a.position - b.position)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamStates failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamLabels(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    const labels = await team.labels()
    return labels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamLabels failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamMembers(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    const members = await team.members()
    return members.nodes.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl ?? undefined
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamMembers failed:', error)
    return []
  } finally {
    release()
  }
}
