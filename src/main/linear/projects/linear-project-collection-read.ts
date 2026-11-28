import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearWorkspaceSelection
} from '../../../shared/linear/workspace-types'
import { acquire, release } from '../requests/linear-request-concurrency'
import { clearToken } from '../accounts/linear-token-store'
import {
  getClients,
  isAuthError,
  type LinearClientForWorkspace
} from '../accounts/linear-account-client'
import {
  coalesce,
  normalizeConcreteWorkspaceId,
  shouldFailWholeRequest,
  workspaceError
} from '../collections/linear-collection-models'

export async function readCollection<T>(
  key: string,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  load: (
    entry: LinearClientForWorkspace,
    yieldSlot: () => Promise<void>
  ) => Promise<LinearCollectionResult<T>>,
  force = false,
  signal?: AbortSignal
): Promise<LinearCollectionResult<T>> {
  const entries = await getClients(workspaceId, signal)
  if (entries.length === 0) {
    return { items: [] }
  }
  // Resolve mutable default/all selections before sharing an in-flight request.
  const scopedKey = JSON.stringify([
    key,
    entries.map(({ workspace }) => [workspace.id, workspace.credentialRevision ?? 0])
  ])
  return coalesce(
    scopedKey,
    async () => {
      const results = await Promise.all(
        entries.map(async (entry) => {
          await acquire(signal)
          let holdsSlot = true
          // Multi-page loads requeue between pages so a long walk cannot starve other reads.
          const yieldSlot = async () => {
            release()
            holdsSlot = false
            await acquire(signal)
            holdsSlot = true
          }
          try {
            signal?.throwIfAborted()
            return await load(entry, yieldSlot)
          } catch (error) {
            if (isAuthError(error)) {
              await clearToken(entry.workspace.id)
            } else {
              console.warn('[linear] project/view read failed:', error)
            }
            if (shouldFailWholeRequest(workspaceId)) {
              throw error
            }
            return { items: [], errors: [workspaceError(entry, error)] }
          } finally {
            if (holdsSlot) {
              release()
            }
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
    force,
    signal
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
