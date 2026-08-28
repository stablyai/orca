import type { LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId
} from '../../shared/linear/workspace-types'
import {
  LINEAR_ISSUE_API_PAGE_SIZE_MAX,
  clampLinearIssueListLimit
} from '../../shared/linear/issue-read-limits'
import type { LinearClientForWorkspace } from './client'
import { PROJECT_ISSUES_QUERY } from './linear-project-graphql'
import type {
  LinearConnection,
  LinearIssueNode,
  LinearRawVariables,
  ProjectIssueConnectionResponse
} from './linear-project-nodes'
import { mapIssueForWorkspace, normalizeConcreteWorkspaceId } from './linear-project-models'
import { readConcreteCollection } from './linear-project-collection-read'

export async function readIssueConnectionPages(
  entry: LinearClientForWorkspace,
  limit: number,
  loadConnection: (variables: {
    first: number
    after?: string
  }) => Promise<LinearConnection<LinearIssueNode> | null | undefined>
): Promise<LinearCollectionResult<LinearIssue>> {
  const items: LinearIssue[] = []
  let after: string | undefined
  let hasMore = false

  while (items.length < limit) {
    // Why: Linear returns issue connections in pages of up to 50; expanded
    // Orca reads must follow cursors to show more than one backend page.
    const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit - items.length)
    const connection = await loadConnection(after ? { first, after } : { first })
    const nodes = connection?.nodes ?? []
    items.push(...nodes.map((issue) => mapIssueForWorkspace(entry, issue)))
    hasMore = Boolean(connection?.pageInfo?.hasNextPage)

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor || nextCursor === after || nodes.length === 0) {
      break
    }
    after = nextCursor
  }

  return { items, hasMore }
}

export async function listProjectIssues(
  projectId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearCollectionResult<LinearIssue>> {
  const id = projectId.trim()
  if (!id) {
    throw new Error('Project ID is required')
  }
  const first = clampLinearIssueListLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listProjectIssues:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      return readIssueConnectionPages(entry, first, async (page) => {
        const result = await entry.client.client.rawRequest<
          ProjectIssueConnectionResponse,
          LinearRawVariables
        >(PROJECT_ISSUES_QUERY, { id, ...page, orderBy: 'updatedAt' })
        const project = result.data?.project
        if (!project) {
          throw new Error('Project was not found')
        }
        return project.issues
      })
    },
    force
  )
}
