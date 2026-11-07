import { acquire, release } from './linear-request-concurrency'
import { getClients, isAuthError } from './client'
import { clearToken } from './linear-token-store'
import { linearError } from './issue-context/errors'
import { isLinearUuid } from '../../shared/linear/uuid'

export async function resolveIssueCycle(
  input: string | null,
  teamId: string,
  workspaceId: string,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  if (input === null) {
    return null
  }
  if (input !== 'current' && !isLinearUuid(input)) {
    throw linearError('linear_write_failed', 'Cycle must be current, a cycle UUID, or null.')
  }
  const entry = getClients(workspaceId, signal)[0]
  if (!entry) {
    throw linearError('linear_write_failed', 'Not connected to the issue workspace.')
  }
  await acquire(signal)
  try {
    const cycles = await entry.client.cycles({
      first: 2,
      filter: {
        team: { id: { eq: teamId } },
        ...(input === 'current' ? { isActive: { eq: true } } : { id: { eq: input } })
      }
    })
    signal?.throwIfAborted()
    if (cycles.nodes.length !== 1 || cycles.pageInfo.hasNextPage) {
      throw linearError(
        'linear_write_failed',
        input === 'current'
          ? 'The issue team must have exactly one current cycle.'
          : 'The cycle was not found in the issue team and workspace.'
      )
    }
    return cycles.nodes[0].id
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}
