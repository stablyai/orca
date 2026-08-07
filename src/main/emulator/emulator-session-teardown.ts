import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type { EmulatorBackend, EmulatorBackendKind } from './backends/emulator-backend'

// Session stop/teardown mechanics extracted from EmulatorBridge; the bridge
// stays the router and delegates here with its registry + backend lookup.
export type EmulatorSessionTeardownDeps = {
  backendForKind(kind: EmulatorBackendKind): EmulatorBackend | null
  registry: EmulatorSessionRegistry
}

export type StopActiveSessionOptions = {
  managedOnly?: boolean
  shutdownDevice?: boolean
}

export async function stopActiveSessionForWorktree(
  deps: EmulatorSessionTeardownDeps,
  worktreeId: string,
  options: StopActiveSessionOptions = {}
): Promise<string | null> {
  const key = deps.registry.getActiveSessionKey(worktreeId)
  if (!key) {
    return null
  }
  const session = deps.registry.getSession(key)
  deps.registry.unregisterWorktree(worktreeId)
  if (!session || (options.managedOnly && !session.managed)) {
    return null
  }
  const backend = deps.backendForKind(session.backend)
  if (!backend) {
    return null
  }
  await backend.stopHelperForDevice(session.deviceUdid, {
    helperPid: session.pid,
    includeOrphaned: !options.managedOnly
  })
  if (options.shutdownDevice) {
    await backend.shutdownDevice(session.deviceUdid).catch(() => {})
  }
  deps.registry.clearSessionAndWorktrees(key)
  return session.deviceUdid
}

// Shared by kill (helpers only) and shutdown (helpers + device). A shutdown
// failure propagates before the session is cleared, matching bridge behavior.
export async function stopSessionByUdid(
  deps: EmulatorSessionTeardownDeps,
  backend: EmulatorBackend,
  udid: string,
  options: { shutdownDevice?: boolean } = {}
): Promise<string> {
  await backend.stopHelperForDevice(udid, {
    helperPid: deps.registry.getSession(udid)?.pid,
    includeOrphaned: true
  })
  if (options.shutdownDevice) {
    await backend.shutdownDevice(udid)
  }
  deps.registry.clearSessionAndWorktrees(udid)
  return udid
}

export async function destroyAllManagedSessions(deps: EmulatorSessionTeardownDeps): Promise<void> {
  const promises: Promise<unknown>[] = []
  for (const session of deps.registry.listSessions()) {
    if (!session.managed) {
      continue
    }
    const backend = deps.backendForKind(session.backend)
    if (!backend) {
      continue
    }
    promises.push(
      backend
        .stopHelperForDevice(session.deviceUdid, { helperPid: session.pid })
        .catch(() => {})
        .then(() => backend.shutdownDevice(session.deviceUdid).catch(() => {}))
    )
  }
  await Promise.allSettled(promises)
  deps.registry.clear()
}
