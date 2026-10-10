import type { LinearProjectDetail, LinearProjectSummary } from '../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import {
  CREATE_PROJECT_MUTATION,
  PROJECT_QUERY,
  PROJECTS_QUERY,
  SEARCH_PROJECTS_QUERY
} from './linear-project-graphql'
import type {
  LinearProjectCreateInput,
  LinearRawVariables,
  ProjectConnectionResponse,
  ProjectMutationResponse
} from './linear-project-nodes'
import {
  clampLimit,
  coalesce,
  LINEAR_PROJECT_API_PAGE_SIZE_MAX,
  mapProjectDetailForWorkspace,
  mapProjectForWorkspace,
  normalizeConcreteWorkspaceId
} from './linear-project-models'
import { readCollection } from './linear-project-collection-read'

export async function listProjects(
  query: string | undefined,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null,
  force = false
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const first = clampLimit(limit)
  const trimmed = query?.trim()
  const key = `listProjects:${workspaceId ?? 'default'}:${trimmed ?? ''}:${first}`
  return readCollection(
    key,
    workspaceId,
    async (entry) => {
      const variables = trimmed ? { term: trimmed, first } : { first, orderBy: 'updatedAt' }
      const result = await entry.client.client.rawRequest<
        ProjectConnectionResponse,
        LinearRawVariables
      >(trimmed ? SEARCH_PROJECTS_QUERY : PROJECTS_QUERY, variables)
      const connection = trimmed ? result.data?.searchProjects : result.data?.projects
      return {
        items: (connection?.nodes ?? []).map((project) => mapProjectForWorkspace(entry, project)),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    },
    force
  )
}

export async function listProjectsByExactName(
  name: string,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearProjectSummary[]> {
  const projectName = name.trim()
  if (!projectName) {
    throw new Error('Project name is required')
  }
  const normalized = projectName.toLowerCase()
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  const key = `listProjectsByExactName:${concreteWorkspaceId}:${normalized}`
  return coalesce(
    key,
    async () => {
      const entries = getClients(concreteWorkspaceId)
      const entry = entries[0]
      if (!entry) {
        return []
      }
      await acquire()
      try {
        const matches: LinearProjectSummary[] = []
        let after: string | undefined
        while (true) {
          const result = await entry.client.client.rawRequest<
            ProjectConnectionResponse,
            LinearRawVariables
          >(SEARCH_PROJECTS_QUERY, {
            term: projectName,
            first: LINEAR_PROJECT_API_PAGE_SIZE_MAX,
            ...(after ? { after } : {})
          })
          const connection = result.data?.searchProjects
          for (const project of connection?.nodes ?? []) {
            if (project.name.trim().toLowerCase() === normalized) {
              matches.push(mapProjectForWorkspace(entry, project))
            }
          }
          const nextCursor = connection?.pageInfo?.endCursor ?? undefined
          if (
            connection?.pageInfo?.hasNextPage !== true ||
            !nextCursor ||
            nextCursor === after ||
            (connection.nodes ?? []).length === 0
          ) {
            break
          }
          after = nextCursor
        }
        return matches
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

export async function getProject(
  id: string,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearProjectDetail | null> {
  const projectId = id.trim()
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  if (!projectId) {
    throw new Error('Project ID is required')
  }
  const key = `getProject:${concreteWorkspaceId}:${projectId}`
  return coalesce(
    key,
    async () => {
      const entries = getClients(concreteWorkspaceId)
      const entry = entries[0]
      if (!entry) {
        return null
      }
      await acquire()
      try {
        const result = await entry.client.client.rawRequest<
          ProjectConnectionResponse,
          LinearRawVariables
        >(PROJECT_QUERY, { id: projectId })
        return result.data?.project
          ? mapProjectDetailForWorkspace(entry, result.data.project)
          : null
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

export async function createProject(
  input: LinearProjectCreateInput,
  workspaceId?: string | null
): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.client.rawRequest<
      ProjectMutationResponse,
      LinearRawVariables
    >(CREATE_PROJECT_MUTATION, { input })
    const payload = result.data?.projectCreate
    const project = payload?.project
    if (!payload?.success || !project) {
      return { ok: false, error: 'Linear project create failed' }
    }
    return { ok: true, project: mapProjectDetailForWorkspace(entry, project) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}
