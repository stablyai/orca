import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError, type LinearClientForWorkspace } from './client'
import {
  coalesce,
  normalizeConcreteWorkspaceId,
  shouldFailWholeRequest,
  workspaceError
} from './linear-project-models'

export async function readCollection<T>(
  key: string,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  load: (entry: LinearClientForWorkspace) => Promise<LinearCollectionResult<T>>,
  force = false
): Promise<LinearCollectionResult<T>> {
  return coalesce(
    key,
    async () => {
      const entries = getClients(workspaceId)
      if (entries.length === 0) {
        return { items: [] }
      }

      const results = await Promise.all(
        entries.map(async (entry) => {
          await acquire()
          try {
            return await load(entry)
          } catch (error) {
            if (isAuthError(error)) {
              clearToken(entry.workspace.id)
            } else {
              console.warn('[linear] project/view read failed:', error)
            }
            if (shouldFailWholeRequest(workspaceId)) {
              throw error
            }
            return { items: [], errors: [workspaceError(entry, error)] }
          } finally {
            release()
          }
        })
      )

      return {
        items: results.flatMap((result) => result.items),
        errors: results.flatMap((result) => result.errors ?? []).length
          ? results.flatMap((result) => result.errors ?? [])
          : undefined,
        hasMore: results.some((result) => result.hasMore)
      }
    },
    force
  )
}

export async function readConcreteCollection<T>(
  key: string,
  workspaceId: LinearConcreteWorkspaceId,
  load: (entry: LinearClientForWorkspace) => Promise<LinearCollectionResult<T>>,
  force = false
): Promise<LinearCollectionResult<T>> {
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readCollection(key, concreteWorkspaceId, load, force)
}
