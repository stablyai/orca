import type { LinearClient } from '@linear/sdk'
import { loadLinearSdk } from './linear-sdk'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { isAuthError, type LinearClientForWorkspace } from './client'
import { classifyLinearError, linearError, linearMessage } from './issue-context-errors'

export type LinearProjectRawVariables = Record<string, unknown>

/**
 * Like `withLinearRead`, but hands the caller a client so an AbortSignal can be
 * honoured — the SDK only accepts one at construction time.
 */
export async function runLinearProjectRead<T>(
  entry: LinearClientForWorkspace,
  signal: AbortSignal | undefined,
  read: (client: LinearClient) => Promise<T>
): Promise<T> {
  await acquire()
  try {
    return await read(
      signal ? new (loadLinearSdk().LinearClient)({ apiKey: entry.apiKey, signal }) : entry.client
    )
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw linearError('linear_auth_expired', 'Linear authentication expired.', {
        nextSteps: ['Reconnect Linear from Orca settings.']
      })
    }
    throw linearError(classifyLinearError(error), linearMessage(error))
  } finally {
    release()
  }
}

/** Linear throws instead of returning null when a direct entity lookup misses. */
export function isLinearProjectLookupMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Entity not found') || message.includes('Could not find referenced')
}

export function linearProjectWorkspaceCandidate(entry: LinearClientForWorkspace): {
  id: string
  name: string
} {
  return { id: entry.workspace.id, name: entry.workspace.organizationName }
}
