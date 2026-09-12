import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type { EmulatorBackend, EmulatorBackendKind } from './backends/emulator-backend'

export async function destroyManagedEmulatorSessions(
  sessionRegistry: EmulatorSessionRegistry,
  backendForKind: (kind: EmulatorBackendKind) => EmulatorBackend | null
): Promise<void> {
  const promises: Promise<unknown>[] = []
  for (const session of sessionRegistry.listSessions()) {
    if (!session.managed) {
      continue
    }
    const backend = backendForKind(session.backend)
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
  sessionRegistry.clear()
}
