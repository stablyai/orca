import { taskProviderFailure } from '../../../shared/work-items/task-provider-failure'
import type {
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearWorkspaceSelection
} from '../../../shared/linear/workspace-types'
import { acquire, release } from '../requests/linear-request-concurrency'
import { clearToken } from '../accounts/linear-token-store'
import { getClients, isAuthError } from '../accounts/linear-account-client'
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
} from '../collections/linear-collection-nodes'
import {
  clampLimit,
  coalesce,
  LINEAR_PROJECT_API_PAGE_SIZE_MAX,
  mapProjectDetailForWorkspace,
  mapProjectForWorkspace,
  normalizeConcreteWorkspaceId
} from '../collections/linear-collection-models'
import { readCollection } from './linear-project-collection-read'
import {
  linearConnectionHasNextPage,
  readConnectionPages
} from '../issues/context/linear-connection-pages'
import { linearUncappedReadDeadline } from '../requests/linear-read-budget'

export async function listProjects(
  query: string | undefined,
  limit: number | null = 20,
  workspaceId?: LinearWorkspaceSelection | null,
  force = false,
  { signal, summaryOnly = false }: { signal?: AbortSignal; summaryOnly?: boolean } = {}
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  // A null limit reads every page, bounded by the uncapped read budget.
  const cap = limit === null ? Number.POSITIVE_INFINITY : clampLimit(limit)
  const deadline = limit === null ? linearUncappedReadDeadline() : undefined
  const trimmed = query?.trim()
  const detail = !summaryOnly
  const key = `listProjects:${workspaceId ?? 'default'}:${trimmed ?? ''}:${cap}:${detail}`
  return readCollection(
    key,
    workspaceId,
    async (entry, yieldSlot) => {
      const { nodes, hasMore } = await readConnectionPages(
        cap,
        async (page) => {
          const result = await entry.client.client.rawRequest<
            ProjectConnectionResponse,
            LinearRawVariables
          >(
            trimmed ? SEARCH_PROJECTS_QUERY : PROJECTS_QUERY,
            trimmed ? { term: trimmed, ...page, detail } : { ...page, orderBy: 'updatedAt', detail }
          )
          return trimmed ? result.data?.searchProjects : result.data?.projects
        },
        { pageSize: LINEAR_PROJECT_API_PAGE_SIZE_MAX, deadline, beforeNextPage: yieldSlot }
      )
      return {
        items: nodes.map((project) => mapProjectForWorkspace(entry, project)),
        hasMore
      }
    },
    force,
    signal
  )
}

export async function listProjectsByExactName(
  name: string,
  workspaceId: LinearConcreteWorkspaceId,
  force = false,
  signal?: AbortSignal
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
      const entries = await getClients(concreteWorkspaceId, signal)
      const entry = entries[0]
      if (!entry) {
        return []
      }
      await acquire(signal)
      try {
        const matches: LinearProjectSummary[] = []
        let after: string | undefined
        while (true) {
          signal?.throwIfAborted()
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
            !linearConnectionHasNextPage(connection) ||
            !nextCursor ||
            nextCursor === after ||
            (connection?.nodes ?? []).length === 0
          ) {
            break
          }
          after = nextCursor
        }
        return matches
      } catch (error) {
        if (isAuthError(error)) {
          await clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    },
    force,
    signal
  )
}

export async function getProject(
  id: string,
  workspaceId: LinearConcreteWorkspaceId,
  force = false,
  signal?: AbortSignal
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
      const entries = await getClients(concreteWorkspaceId, signal)
      const entry = entries[0]
      if (!entry) {
        return null
      }
      await acquire(signal)
      try {
        signal?.throwIfAborted()
        const result = await entry.client.client.rawRequest<
          ProjectConnectionResponse,
          LinearRawVariables
        >(PROJECT_QUERY, { id: projectId })
        return result.data?.project
          ? mapProjectDetailForWorkspace(entry, result.data.project)
          : null
      } catch (error) {
        if (isAuthError(error)) {
          await clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    },
    force,
    signal
  )
}

export async function createProject(
  input: LinearProjectCreateInput,
  workspaceId?: string | null
): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> {
  const entry = (await getClients(workspaceId))[0]
  if (!entry) {
    return taskProviderFailure('linear.notConnected', 'Not connected to Linear')
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
      return taskProviderFailure('linear.projectCreateFailed', 'Linear project create failed')
    }
    return { ok: true, project: mapProjectDetailForWorkspace(entry, project) }
  } catch (error) {
    if (isAuthError(error)) {
      await clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}
