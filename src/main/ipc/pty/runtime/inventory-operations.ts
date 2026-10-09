import { getPtyIdsForHost } from '../provider/ownership-state'
import { getProvider, localProvider, registeredPtyProviders } from '../provider/registry'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { PtyRuntimeControllerDeps } from './controller-deps'

function markSshInventoryUnverifiable(
  runtime: PtyRuntimeControllerDeps['runtime'],
  hostId: ExecutionHostId,
  error: unknown
): void {
  const reason = error instanceof Error ? error.message : String(error)
  for (const ptyId of getPtyIdsForHost(hostId)) {
    runtime?.markPtyLivenessUnverifiable?.(ptyId, reason)
  }
}

export async function listProcessesWithHostScopeFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
): Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }> {
  const providerSessions = await Promise.all(
    registeredPtyProviders().map(async ({ provider, hostId }) => {
      const isLocal = hostId === LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await (isLocal ? provider.listProcesses() : provider.listProcesses(opts)),
          hostId
        }
      } catch (error) {
        if (isLocal) {
          throw error
        }
        markSshInventoryUnverifiable(deps.runtime, hostId, error)
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
    const hostId = getConnectionExecutionHostId(connectionId)
    try {
      return await getProvider(hostId).listProcesses(opts)
    } catch (error) {
      markSshInventoryUnverifiable(deps.runtime, hostId, error)
      throw error
    }
  }
  return (await listProcessesWithHostScopeFromRuntimeController(deps, opts)).processes
}
