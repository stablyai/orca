import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import { hasMainOwnedRuntimeSessionNamespace } from './runtime-workspace-session-namespace-custody'

export async function retireUnownedRuntimeSession(
  store: Store,
  environmentId: string
): Promise<boolean> {
  const hostId = toRuntimeExecutionHostId(environmentId)
  try {
    if (hasMainOwnedRuntimeSessionNamespace(store, hostId)) {
      return false
    }
  } catch (error) {
    console.warn('[runtime-environments] Preserving session after custody lookup failure:', error)
    return false
  }
  return store.removeRuntimeWorkspaceSessionPartition(hostId, () =>
    hasMainOwnedRuntimeSessionNamespace(store, hostId)
  )
}
