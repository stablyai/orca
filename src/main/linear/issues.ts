import type { LinearIssue } from '../../shared/types'
import { acquire, release, getClient, isAuthError, clearToken } from './client'
import { mapLinearIssue } from './mappers'

export async function getIssue(id: string): Promise<LinearIssue | null> {
  const client = getClient()
  if (!client) {
    return null
  }

  await acquire()
  try {
    const issue = await client.issue(id)
    return await mapLinearIssue(issue)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] getIssue failed:', error)
    return null
  } finally {
    release()
  }
}

export async function searchIssues(query: string, limit = 20): Promise<LinearIssue[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const result = await client.searchIssues(query, { first: limit })
    return await Promise.all(result.nodes.map(mapLinearIssue))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] searchIssues failed:', error)
    return []
  } finally {
    release()
  }
}

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed'

const ACTIVE_STATE_FILTER = { state: { type: { nin: ['completed', 'canceled'] } } }
const COMPLETED_STATE_FILTER = { state: { type: { in: ['completed', 'canceled'] } } }

export async function listIssues(
  filter: LinearListFilter = 'assigned',
  limit = 20
): Promise<LinearIssue[]> {
  const client = getClient()
  if (!client) {
    return []
  }

  await acquire()
  try {
    const orderBy = 'updatedAt' as never

    if (filter === 'assigned') {
      const viewer = await client.viewer
      const connection = await viewer.assignedIssues({
        first: limit,
        orderBy,
        filter: ACTIVE_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    if (filter === 'created') {
      const viewer = await client.viewer
      const connection = await viewer.createdIssues({
        first: limit,
        orderBy,
        filter: ACTIVE_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    if (filter === 'completed') {
      const viewer = await client.viewer
      const connection = await viewer.assignedIssues({
        first: limit,
        orderBy,
        filter: COMPLETED_STATE_FILTER
      })
      return await Promise.all(connection.nodes.map(mapLinearIssue))
    }

    // 'all' — all active issues across the workspace
    const connection = await client.issues({
      first: limit,
      orderBy,
      filter: ACTIVE_STATE_FILTER
    })
    return await Promise.all(connection.nodes.map(mapLinearIssue))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken()
      throw error
    }
    console.warn('[linear] listIssues failed:', error)
    return []
  } finally {
    release()
  }
}
