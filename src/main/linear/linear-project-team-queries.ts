import type { LinearProjectSummary } from '../../shared/linear/project-types'
import type { LinearConcreteWorkspaceId } from '../../shared/linear/workspace-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import { PROJECT_TEAMS_QUERY } from './linear-project-graphql'
import type { LinearRawVariables, ProjectTeamsResponse } from './linear-project-nodes'
import { coalesce, normalizeConcreteWorkspaceId } from './linear-project-models'

export async function listProjectTeams(
  projectId: string,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<NonNullable<LinearProjectSummary['teams']>> {
  const id = projectId.trim()
  if (!id) {
    throw new Error('Project ID is required')
  }
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  const key = `listProjectTeams:${concreteWorkspaceId}:${id}`
  return coalesce(
    key,
    async () => {
      const entry = getClients(concreteWorkspaceId)[0]
      if (!entry) {
        return []
      }
      const teams: NonNullable<LinearProjectSummary['teams']> = []
      let after: string | undefined
      await acquire()
      try {
        while (true) {
          const result = await entry.client.client.rawRequest<
            ProjectTeamsResponse,
            LinearRawVariables
          >(PROJECT_TEAMS_QUERY, {
            id,
            first: 50,
            ...(after ? { after } : {})
          })
          const project = result.data?.project
          if (!project) {
            throw new Error('Project was not found')
          }
          const connection = project.teams
          const nodes = connection?.nodes ?? []
          teams.push(
            ...nodes.map((team) => ({
              id: team.id,
              name: team.name ?? '',
              key: team.key ?? undefined
            }))
          )
          const nextCursor = connection?.pageInfo?.endCursor ?? undefined
          if (
            !connection?.pageInfo?.hasNextPage ||
            !nextCursor ||
            nextCursor === after ||
            nodes.length === 0
          ) {
            break
          }
          after = nextCursor
        }
        return teams
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    },
    force
  )
}
