import type { EmulatorBridge } from './emulator-bridge'
import type { EmulatorBackend, EmulatorBackendKind } from './backends/emulator-backend'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type { EmulatorStartLeaseRegistry } from './emulator-start-lease-registry'

export async function stopTargetSession(
  registry: EmulatorSessionRegistry,
  leases: EmulatorStartLeaseRegistry,
  backend: EmulatorBackend,
  udid: string,
  shutdown: boolean
): Promise<string> {
  const session = registry.getSession(udid)
  await leases.cleanupWhenIdle(backend, registry.sessionInfoOrTarget(udid), () => false, {
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
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null
): Promise<void> {
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
  await Promise.allSettled(promises)
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
