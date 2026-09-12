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
  log = console.info
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
  const removed = store.pruneOrphanedRuntimeHostWorkspaceSessions(
    new Set(environments.map((environment) => environment.id))
  )
  if (removed.length > 0) {
    log(`[runtime-host-session] pruned ${removed.length} orphaned runtime host session(s)`)
  }
}
