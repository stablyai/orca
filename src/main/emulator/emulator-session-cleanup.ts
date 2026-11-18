import type { EmulatorBridge } from './emulator-bridge'
import type { EmulatorBackend, EmulatorBackendKind } from './backends/emulator-backend'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type { EmulatorStartLeaseRegistry } from './emulator-start-lease-registry'
import type { EmulatorSessionInfo } from './emulator-types'
import type { EmulatorSessionState } from './emulator-bridge-types'

export function censusCleanup(
  registry: EmulatorSessionRegistry,
  leases: EmulatorStartLeaseRegistry,
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null
): (kind: EmulatorBackendKind, session: EmulatorSessionState) => void {
  return (kind, session) => {
    const backend = backendForKind(kind)
    if (backend) {
      const info = registry.toSessionInfo(session)
      void leases
        .cleanupWhenIdle(backend, info, () => false, {
          force: true,
          validate: () => {
            if (registry.getSession(info.deviceUdid) !== session) {
              throw new Error('The emulator changed during device census.')
            }
            if (kind === 'android') {
              const owned = backend.ownedSessionInfo?.(info.deviceUdid)
              if (owned && (!info.instanceId || owned.instanceId !== info.instanceId)) {
                throw new Error('The Android emulator stream changed during device census.')
              }
              registry.clearIfUnchanged(info.deviceUdid, session)
              if (!owned) {
                throw new Error('The Android emulator stream is already gone.')
              }
              return
            }
            registry.clearIfUnchanged(info.deviceUdid, session)
          }
        })
        .catch(() => {})
    }
  }
}

export async function stopTargetSession(
  registry: EmulatorSessionRegistry,
  leases: EmulatorStartLeaseRegistry,
  backend: EmulatorBackend,
  udid: string,
  shutdown: boolean
): Promise<string> {
  const session = registry.getSession(udid)
  const info = session
    ? registry.toSessionInfo(session)
    : (backend.ownedSessionInfo?.(udid) ?? registry.sessionInfoOrTarget(udid))
  await leases.cleanupWhenIdle(backend, info, () => false, {
    includeOrphaned: true,
    shutdownDevice: shutdown,
    force: true,
    validate: () => {
      if (registry.getSession(udid) !== session) {
        throw new EmulatorError(
          'emulator_attach_superseded',
          'The emulator changed before it could be stopped.'
        )
      }
    }
  })
  registry.clearIfUnchanged(udid, session)
  return udid
}

export async function destroySessions(
  registry: EmulatorSessionRegistry,
  leases: EmulatorStartLeaseRegistry,
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null,
  backends: EmulatorBackend[],
  options: { deadline?: number; signal?: AbortSignal } = {}
): Promise<void> {
  await leases.closeAndDrain(options)
  const promises = registry
    .listSessions()
    .filter((session) => session.managed)
    .map(async (session) => {
      const backend = backendForKind(session.backend)
      if (!backend) {
        return
      }
      await leases.cleanupWhenIdle(backend, registry.toSessionInfo(session), () => false, {
        shutdownDevice: true,
        releaseOnShutdownFailure: true,
        force: true,
        validate: () => {
          if (registry.getSession(session.deviceUdid) !== session) {
            throw new EmulatorError(
              'emulator_attach_superseded',
              'The emulator changed before shutdown.'
            )
          }
        }
      })
      registry.clearIfUnchanged(session.deviceUdid, session)
    })
  const results = await Promise.allSettled(promises)
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(
        '[emulator] Session shutdown incomplete; ownership may be retained:',
        result.reason
      )
    }
  }
  const remaining = await Promise.allSettled(
    backends.map((backend) => backend.stopOwnedHelpers?.())
  )
  const failure = remaining.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
  }
  const shutdownFailure = results.find((result) => result.status === 'rejected')
  if (shutdownFailure?.status === 'rejected') {
    throw shutdownFailure.reason
  }
}

export async function stopForSwitch(
  bridge: EmulatorBridge,
  registry: EmulatorSessionRegistry,
  worktreeId: string,
  stop: (shutdownDevice: boolean) => Promise<string | null>,
  assertCurrent?: () => void
): Promise<string | null> {
  const key = registry.getActiveSessionKey(worktreeId)
  const session = key ? registry.getSession(key) : undefined
  const active = bridge.getActiveForWorktree(worktreeId)
  const shutdownDevice =
    active?.backend !== 'android' && !!(await bridge.getReusableActiveForWorktree(worktreeId))
  assertCurrent?.()
  if (
    registry.getActiveSessionKey(worktreeId) !== key ||
    (key && registry.getSession(key) !== session)
  ) {
    throw new EmulatorError(
      'emulator_attach_superseded',
      'The active emulator changed during device selection.'
    )
  }
  return stop(shutdownDevice)
}

export async function reusableForWorkspace(
  registry: EmulatorSessionRegistry,
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null,
  worktreeId: string,
  device?: string
): Promise<EmulatorSessionInfo | null> {
  const active = registry.getActiveForWorktree(worktreeId)
  if (!active) {
    return null
  }
  const backend = backendForKind(active.backend ?? 'ios')
  if (!backend) {
    return null
  }
  const generation = registry.generationForDevice(active.deviceUdid)
  const assertOwner = () => {
    if (!registry.isCurrentOwner(worktreeId, active.deviceUdid, generation)) {
      throw new EmulatorError(
        'emulator_attach_superseded',
        'The active emulator changed during the connection check.'
      )
    }
  }
  if (device) {
    const resolved = await backend.resolveDeviceId(device).catch(() => null)
    assertOwner()
    if (resolved !== active.deviceUdid) {
      return null
    }
  }
  const reusable = await backend.isSessionReusable(active)
  assertOwner()
  return reusable ? active : null
}

export async function stopWorkspaceSession(
  registry: EmulatorSessionRegistry,
  leases: EmulatorStartLeaseRegistry,
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null,
  worktreeId: string,
  options: { shutdownDevice?: boolean; managedOnly?: boolean }
): Promise<string | null> {
  const key = registry.getActiveSessionKey(worktreeId)
  if (!key) {
    return null
  }
  const session = registry.getSession(key)
  registry.unregisterWorktree(worktreeId)
  if (!session || (options.managedOnly && !session.managed)) {
    return null
  }
  if (registry.hasActiveWorktreeForSession(key)) {
    return session.deviceUdid
  }
  const backend = backendForKind(session.backend)
  if (!backend) {
    return null
  }
  const sessionInfo = registry.toSessionInfo(session)
  try {
    await leases.cleanupWhenIdle(
      backend,
      sessionInfo,
      (info) => registry.hasActiveWorktreeForSession(info.deviceUdid),
      {
        includeOrphaned: !options.managedOnly,
        shutdownDevice: options.shutdownDevice
      }
    )
  } catch (error) {
    registry.restoreIfUnchanged(worktreeId, session)
    throw error
  }
  if (!registry.hasActiveWorktreeForSession(key)) {
    registry.clearIfUnchanged(key, session)
  }
  return session.deviceUdid
}
