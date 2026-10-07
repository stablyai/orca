import { app } from 'electron'
import { parseExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Store } from '../persistence'
import { hasMainOwnedRuntimeSessionNamespace } from '../runtime/runtime-workspace-session-namespace-custody'

export function canAdmitRendererSessionWrite(store: Store, hostId?: string | null): boolean {
  const parsed = parseExecutionHostId(hostId)
  // Retired snapshots reach the Store's archive-only writer.
  if (parsed && store.isRuntimeWorkspaceSessionRetired(parsed.id)) {
    return true
  }
  if (parsed?.kind !== 'runtime' || store.getWorkspaceSessionHostIds().includes(parsed.id)) {
    return true
  }
  if (hasMainOwnedRuntimeSessionNamespace(store, parsed.id)) {
    return true
  }
  return listEnvironments(app.getPath('userData'), { requireStoreFile: true }).some(
    (entry) => entry.id === parsed.environmentId
  )
}
