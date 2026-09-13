import { listEnvironments } from '../shared/runtime-environment-store'

type RuntimeHostSessionStore = {
  pruneOrphanedRuntimeHostWorkspaceSessions: (
    knownEnvironmentIds: ReadonlySet<string>
  ) => readonly string[]
}

export function selfHealRuntimeHostWorkspaceSessions({
  store,
  userDataPath,
  listKnownEnvironments = listEnvironments,
  log = console.warn
}: {
  store: RuntimeHostSessionStore
  userDataPath: string
  listKnownEnvironments?: typeof listEnvironments
  log?: (message: string) => void
}): void {
  let environments: ReturnType<typeof listEnvironments>
  try {
    // A missing or unreadable registry cannot prove that a saved host was removed.
    environments = listKnownEnvironments(userDataPath, { requireExisting: true })
  } catch {
    return
  }
  if (environments.length === 0) {
    // The registry has no locking; a lost concurrent write can empty it. Never wipe every runtime
    // partition on that evidence — the deletion is irreversible.
    log('[runtime-host-session] registry is empty; skipping orphaned runtime host session prune')
    return
  }
  const removed = store.pruneOrphanedRuntimeHostWorkspaceSessions(
    new Set(environments.map((environment) => environment.id))
  )
  if (removed.length > 0) {
    log(
      `[runtime-host-session] pruned ${removed.length} orphaned runtime host session(s) not in the environment registry: ${removed.join(', ')}`
    )
  }
}
