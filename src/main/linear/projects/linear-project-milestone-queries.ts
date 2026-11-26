import type { LinearConcreteWorkspaceId } from '../../../shared/linear/workspace-types'
import { PROJECT_MILESTONES_QUERY } from './linear-project-graphql'
import type {
  LinearRawVariables,
  ProjectMilestonesResponse
} from '../collections/linear-collection-nodes'
import { normalizeConcreteWorkspaceId } from '../collections/linear-collection-models'
import { readConnectionPages } from '../issues/context/linear-connection-pages'
import { readCollection } from './linear-project-collection-read'

const PROJECT_MILESTONE_READ_CAP = 250

export async function listProjectMilestones(
  projectId: string,
  workspaceId: LinearConcreteWorkspaceId,
  signal?: AbortSignal
): Promise<{ milestones: { id: string; name: string }[]; hasMore: boolean }> {
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  const result = await readCollection(
    `listProjectMilestones:${concreteWorkspaceId}:${projectId}`,
    concreteWorkspaceId,
    async (entry, yieldSlot) => {
      const { nodes, hasMore } = await readConnectionPages(
        PROJECT_MILESTONE_READ_CAP,
        async (page) => {
          signal?.throwIfAborted()
          const response = await entry.client.client.rawRequest<
            ProjectMilestonesResponse,
            LinearRawVariables
          >(PROJECT_MILESTONES_QUERY, { id: projectId, ...page })
          const project = response.data?.project
          if (!project) {
            throw new Error('Project was not found')
          }
          return project.projectMilestones
        },
        { beforeNextPage: yieldSlot }
      )
      return {
        items: nodes.map((milestone) => ({ id: milestone.id, name: milestone.name ?? '' })),
        hasMore
      }
    },
    true,
    signal
  )
  return { milestones: result.items, hasMore: result.hasMore === true }
}
