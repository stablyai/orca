import {
  createLocalInventoryAuthority,
  type LocalInventoryAuthorityDeps
} from '../provider/local-inventory-authority'
import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, localProvider, registeredPtyProviders } from '../provider/registry'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'

function markSshInventoryUnverifiable(
  runtime: LocalInventoryAuthorityDeps['runtime'],
  connectionId: string,
  error: unknown
): void {
  const reason = error instanceof Error ? error.message : String(error)
  for (const [ptyId, ownerConnectionId] of ptyOwnership) {
    if (ownerConnectionId === connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, reason)
    }
  }
}

export async function listProcessesWithHostScopeFromRuntimeController(
  deps: LocalInventoryAuthorityDeps,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
): Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }> {
  const localAuthority = createLocalInventoryAuthority(deps)
  const providerSessions = await Promise.all(
    registeredPtyProviders().map(async ({ provider, connectionId }) => {
      const hostId: ExecutionHostId = connectionId
        ? toSshExecutionHostId(connectionId)
        : LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await (provider === localProvider
            ? provider.listProcesses()
            : provider.listProcesses(opts)),
          hostId
        }
      } catch (error) {
        if (!connectionId) {
          if (provider === localProvider) {
            throw error
          }
          localAuthority.failed(provider, error)
          return null
        }
        markSshInventoryUnverifiable(deps.runtime, connectionId, error)
        return null
      }
    })
  )
  const respondingSessions = providerSessions.filter((session) => session !== null)
  return {
    processes: respondingSessions.flatMap((session) => session.processes),
    hostIds: [...new Set(respondingSessions.map((session) => session.hostId))].filter(
      (hostId) => hostId !== LOCAL_EXECUTION_HOST_ID || localAuthority.isComplete()
    )
  }
}

export async function listProcessesFromRuntimeController(
  deps: LocalInventoryAuthorityDeps,
  connectionId?: string | null,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
) {
  if (connectionId === null) {
    const localAuthority = createLocalInventoryAuthority(deps)
    const rows = await Promise.all(
      registeredPtyProviders()
        .filter(({ connectionId }) => connectionId === null)
        .map(async ({ provider }) => {
          try {
            return await (provider === localProvider
              ? provider.listProcesses()
              : provider.listProcesses(opts))
          } catch (error) {
            if (provider === localProvider) {
              throw error
            }
            localAuthority.failed(provider, error)
            return []
          }
        })
    )
    localAuthority.assertComplete()
    return rows.flat()
  }
  if (connectionId !== undefined) {
    try {
      return await getProvider(connectionId).listProcesses(opts)
    } catch (error) {
      markSshInventoryUnverifiable(deps.runtime, connectionId, error)
      throw error
    }
  }
  return (await listProcessesWithHostScopeFromRuntimeController(deps, opts)).processes
}
