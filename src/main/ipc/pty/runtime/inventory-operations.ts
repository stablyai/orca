import { ptyOwnership } from '../provider/ownership-state'
import {
  getProvider,
  registeredPtyProviders,
  type RegisteredPtyProvider
} from '../provider/registry'
import {
  readRegisteredPtyProviderInventory,
  assertRegisteredPtyInventoryCurrent
} from '../provider/registered-provider-inventory'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { PtyRuntimeControllerDeps } from './controller-deps'

async function readRuntimeProviderInventory(
  deps: PtyRuntimeControllerDeps,
  entry: RegisteredPtyProvider,
  opts: Parameters<typeof readRegisteredPtyProviderInventory>[1]
) {
  try {
    return await readRegisteredPtyProviderInventory(entry, opts)
  } catch (error) {
    if (entry.delegatedIdentity && entry.isCurrent?.() !== false) {
      deps.runtime?.markPtyLivenessUnverifiable?.(
        entry.delegatedIdentity.terminalId,
        'delegated_pty_inventory_unverifiable'
      )
    }
    throw error
  }
}

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
  const entries = registeredPtyProviders()
  const providerSessions = await Promise.all(
    entries.map(async (entry) => {
      const { connectionId } = entry
      const hostId: ExecutionHostId = connectionId
        ? toSshExecutionHostId(connectionId)
        : LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await readRuntimeProviderInventory(deps, entry, opts),
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
  assertRegisteredPtyInventoryCurrent(entries)
  const respondingSessions = providerSessions.filter((session) => session !== null)
  return {
    processes: respondingSessions.flatMap((session) => session.processes),
    hostIds: [...new Set(respondingSessions.map((session) => session.hostId))]
  }
}

export async function listProcessesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  connectionId?: string | null,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
) {
  if (connectionId === null) {
    const entries = registeredPtyProviders().filter((entry) => entry.connectionId === null)
    const sessions = await Promise.all(
      entries.map((entry) => readRuntimeProviderInventory(deps, entry, opts))
    )
    assertRegisteredPtyInventoryCurrent(entries)
    return sessions.flat()
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
