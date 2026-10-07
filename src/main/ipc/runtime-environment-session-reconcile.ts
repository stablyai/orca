import { listEnvironments } from '../../shared/runtime-environment-store'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import { retireUnownedRuntimeSession } from '../runtime/retire-unowned-runtime-session'

export async function reconcileOrphanedRuntimeSessions({
  store,
  userDataPath,
  listKnownEnvironments = listEnvironments,
  log = console.warn
}: {
  store: Store
  userDataPath: string
  listKnownEnvironments?: typeof listEnvironments
  log?: (message: string, error?: unknown) => void
}): Promise<void> {
  let environments: ReturnType<typeof listEnvironments>
  try {
    environments = listKnownEnvironments(userDataPath, { requireStoreFile: true })
  } catch {
    return
  }
  // An empty registry may be a lost concurrent write; explicit observed removal handles the last host.
  if (environments.length === 0) {
    return
  }
  const known = new Set(environments.map((environment) => environment.id))
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    const host = parseExecutionHostId(hostId)
    // Older runtime namespaces need not be paired-host IDs.
    if (
      host?.kind !== 'runtime' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(host.environmentId) ||
      known.has(host.environmentId)
    ) {
      continue
    }
    try {
      await retireUnownedRuntimeSession(store, host.environmentId)
    } catch (error) {
      log('[runtime-host-session] Retaining session after archive or persistence failure:', error)
    }
  }
}
