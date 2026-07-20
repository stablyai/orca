import { existsSync } from 'node:fs'
import { getEnvironmentStorePath, listEnvironments } from '../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../shared/runtime-environments'

type RuntimeHostSessionStore = {
  pruneOrphanedRuntimeHostWorkspaceSessions: (
    knownEnvironmentIds: ReadonlySet<string>
  ) => readonly string[]
}

type SelfHealRuntimeHostWorkspaceSessionsArgs = {
  store: RuntimeHostSessionStore
  userDataPath: string
  listKnownEnvironments?: (userDataPath: string) => KnownRuntimeEnvironment[]
  environmentStoreExists?: (userDataPath: string) => boolean
  log?: (message: string) => void
}

/**
 * Whether the saved runtime-environment registry file exists on disk.
 *
 * Why: `listEnvironments` returns `[]` for a MISSING registry file (it only
 * throws for a corrupt one), so the boot self-heal must distinguish a
 * transiently-absent file from a genuinely empty one before it prunes anything.
 */
function runtimeEnvironmentStoreExists(userDataPath: string): boolean {
  return existsSync(getEnvironmentStorePath(userDataPath))
}

/**
 * Boot self-heal: drop persisted terminal workspace-session partitions that
 * belong to runtime environments no longer in the saved store.
 *
 * Why: removing a runtime environment used to leave its `runtime:<id>` partition
 * in `workspaceSessionsByHostId`. On the next launch the renderer restores those
 * terminal tabs and resubscribes against the now-unknown environment, which the
 * main handler rejects with `Unknown environment: <id>` — flooding the renderer
 * with `runtimeEnvironments:subscribe` errors. Running before the main window
 * loads (mirrors selfHealRuntimeEnvironmentFocus) means the orphaned partition
 * is gone before the renderer can ever restore it, repairing already-broken
 * installs with zero user action.
 */
export function selfHealRuntimeHostWorkspaceSessions({
  store,
  userDataPath,
  listKnownEnvironments = listEnvironments,
  environmentStoreExists = runtimeEnvironmentStoreExists,
  log
}: SelfHealRuntimeHostWorkspaceSessionsArgs): void {
  // Why: a transiently-absent registry file at boot (e.g. a mount/sync race)
  // must not be read as "zero saved environments" and permanently wipe every
  // runtime host's terminal session — deleting a host session is not recoverable,
  // unlike the focus id the sibling self-heal clears. So skip pruning entirely
  // unless the registry file actually exists; a genuinely empty-but-present
  // registry still prunes correctly.
  if (!environmentStoreExists(userDataPath)) {
    return
  }

  let environments: KnownRuntimeEnvironment[]
  try {
    environments = listKnownEnvironments(userDataPath)
  } catch {
    // Why: an unreadable/corrupt registry must not delete possibly-valid host
    // sessions; keep them and let a later launch heal once it reads again.
    return
  }

  const knownEnvironmentIds = new Set<string>()
  for (const environment of environments) {
    knownEnvironmentIds.add(environment.id)
  }

  const removed = store.pruneOrphanedRuntimeHostWorkspaceSessions(knownEnvironmentIds)
  if (removed.length > 0) {
    const writeLog = log ?? console.info
    writeLog(
      `[runtime-host-session] pruned ${removed.length} orphaned runtime host session(s): ${removed.join(', ')}`
    )
  }
}
