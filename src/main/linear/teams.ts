import type { LinearTeam, LinearWorkflowState, LinearLabel, LinearMember } from '../../shared/types'
import { acquire, release, getClient, isAuthError, clearToken } from './client'

export async function listTeams(): Promise<LinearTeam[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const teams = await client.teams()
    return teams.nodes
      .map((t) => ({ id: t.id, name: t.name, key: t.key }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] listTeams failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamStates(teamId: string): Promise<LinearWorkflowState[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
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
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamStates failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamLabels(teamId: string): Promise<LinearLabel[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
    const labels = await team.labels()
    return labels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamLabels failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamMembers(teamId: string): Promise<LinearMember[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const team = await client.team(teamId)
    const members = await team.members()
    return members.nodes.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl ?? undefined
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getTeamMembers failed:', error)
    return []
  } finally {
    release()
  }
}
