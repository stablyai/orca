import type { LinearTeam } from '../../shared/types'
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
