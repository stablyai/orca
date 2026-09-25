import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, localProvider, registeredPtyProviders } from '../provider/registry'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { PtyRuntimeControllerDeps } from './controller-deps'

function markSshInventoryUnverifiable(
  runtime: PtyRuntimeControllerDeps['runtime'],
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
  deps: PtyRuntimeControllerDeps,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
): Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }> {
  const providerSessions = await Promise.all(
    registeredPtyProviders().map(async ({ provider, connectionId }) => {
      const hostId: ExecutionHostId = connectionId
        ? toSshExecutionHostId(connectionId)
        : LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await (connectionId ? provider.listProcesses(opts) : provider.listProcesses()),
          hostId
        }
      } catch (error) {
        if (!connectionId) {
          throw error
        }
        markSshInventoryUnverifiable(deps.runtime, connectionId, error)
        return null
      }
    })
  )
  const respondingSessions = providerSessions.filter((session) => session !== null)
  return {
    processes: respondingSessions.flatMap((session) => session.processes),
    hostIds: respondingSessions.map((session) => session.hostId)
  }
}

export async function listProcessesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  connectionId?: string | null,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
) {
  if (connectionId === null) {
    return localProvider.listProcesses()
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
