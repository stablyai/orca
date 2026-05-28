import type { Project, ProjectSearchResult } from '@linear/sdk'
import type { LinearProjectSummary, LinearWorkspaceSelection } from '../../shared/types'
import { acquire, clearToken, getClients, isAuthError, release } from './client'

function mapLinearProject(project: Project | ProjectSearchResult): LinearProjectSummary {
  return {
    id: project.id,
    name: project.name,
    url: project.url ?? undefined,
    color: project.color ?? undefined
  }
}

export async function listProjects(
  query: string | undefined,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearProjectSummary[]> {
  const trimmed = query?.trim()

  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        if (!trimmed) {
          const connection = await entry.client.projects({ first: limit })
          return connection.nodes.map(mapLinearProject)
        }
        const connection = await entry.client.searchProjects(trimmed, { first: limit })
        return connection.nodes.map(mapLinearProject)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (workspaceId !== 'all') {
            throw error
          }
        } else {
          console.warn('[linear] listProjects failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )

  return results.flat().slice(0, limit)
}
