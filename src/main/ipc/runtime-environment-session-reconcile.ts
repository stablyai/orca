/**
 * Startup reconcile for workspace sessions of servers that no longer exist. Unlinking a server drops
 * its `runtime:<id>` session, but a crash between the two, or a build that unlinked before that
 * drop existed, leaves an orphan that listings keep naming as an unselectable host.
 */
import { existsSync } from 'node:fs'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../shared/runtime-environment-store-file'

type SessionHostStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

/** Returns the dropped hosts. Local and ssh: sessions are never touched. */
export function reconcileOrphanedRuntimeSessions(
  store: SessionHostStore,
  userDataPath: string
): ExecutionHostId[] {
  // Why both guards: a missing file reads as "no servers", and a session must never be deleted
  // on evidence that only means the environment store could not be read.
  if (!existsSync(getEnvironmentStorePath(userDataPath))) {
    return []
  }
  let known: Set<string>
  try {
    known = new Set(listEnvironments(userDataPath).map((environment) => environment.id))
  } catch (error) {
    console.warn('[runtime-environments] skipped orphaned session reconcile:', error)
    return []
  }
  // Safe because a runtime:<id> session is only ever written after that server is registered.
  const dropped = store.getWorkspaceSessionHostIds().filter((hostId) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime' && !known.has(parsed.environmentId)
  })
  for (const hostId of dropped) {
    store.removeWorkspaceSessionHost(hostId)
  }
  return dropped
}
