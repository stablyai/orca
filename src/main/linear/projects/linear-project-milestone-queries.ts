import type { LinearConcreteWorkspaceId } from '../../../shared/linear/workspace-types'
import { acquire, release } from '../requests/linear-request-concurrency'
import { clearToken } from '../accounts/linear-token-store'
import { getClients, isAuthError } from '../accounts/linear-account-client'
import { PROJECT_MILESTONES_QUERY } from './linear-project-graphql'
import type {
  LinearRawVariables,
  ProjectMilestonesResponse
} from '../collections/linear-collection-nodes'
import { normalizeConcreteWorkspaceId } from '../collections/linear-collection-models'
import { readConnectionPages } from '../issues/context/linear-connection-pages'

const PROJECT_MILESTONE_READ_CAP = 250

export async function listProjectMilestones(
  projectId: string,
  workspaceId: LinearConcreteWorkspaceId,
  signal?: AbortSignal
): Promise<{ milestones: { id: string; name: string }[]; hasMore: boolean }> {
  const entry = (await getClients(normalizeConcreteWorkspaceId(workspaceId), signal))[0]
  if (!entry) {
    return { milestones: [], hasMore: false }
  }
  await acquire(signal)
  try {
    const { nodes, hasMore } = await readConnectionPages(
      PROJECT_MILESTONE_READ_CAP,
      async (page) => {
        signal?.throwIfAborted()
        const result = await entry.client.client.rawRequest<
          ProjectMilestonesResponse,
          LinearRawVariables
        >(PROJECT_MILESTONES_QUERY, { id: projectId, ...page })
        const project = result.data?.project
        if (!project) {
          throw new Error('Project was not found')
        }
        return project.projectMilestones
      }
    )
    return {
      milestones: nodes.map((milestone) => ({ id: milestone.id, name: milestone.name ?? '' })),
      hasMore
    }
  } catch (error) {
    if (isAuthError(error)) {
      await clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}
