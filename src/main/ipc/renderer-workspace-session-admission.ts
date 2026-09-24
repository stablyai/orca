import { app } from 'electron'
import { parseExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Store } from '../persistence'
import { hasMainOwnedRuntimeSessionNamespace } from '../runtime/runtime-workspace-session-namespace-custody'

export function canCreateRendererSessionPartition(store: Store, hostId?: string | null): boolean {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime' || store.getWorkspaceSessionHostIds().includes(parsed.id)) {
    return true
  }
  if (hasMainOwnedRuntimeSessionNamespace(store, parsed.id)) {
    return true
  }
  return listEnvironments(app.getPath('userData')).some(
    (entry) => entry.id === parsed.environmentId
  )
}
