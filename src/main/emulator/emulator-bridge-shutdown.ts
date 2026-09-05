import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionRegistry } from './emulator-session-registry'
import type {
  EmulatorStartLeaseRegistry,
  EmulatorStartLease
} from './emulator-start-lease-registry'
import type { EmulatorBackend } from './backends/emulator-backend'

type EmulatorBridgeShutdownOptions = {
  sessionRegistry: EmulatorSessionRegistry
  startLeases: EmulatorStartLeaseRegistry
  backends: EmulatorBackend[]
}

export class EmulatorBridgeShutdown {
  private readonly pendingHelperAcquires = new Set<Promise<EmulatorStartLease>>()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | undefined

  constructor(private readonly options: EmulatorBridgeShutdownOptions) {}

  assertNotShuttingDown(): void {
    if (this.shutdownStarted) {
      throw new EmulatorError('emulator_no_active', 'Emulator runtime is shutting down')
    }
  }

  async trackHelperAcquire(acquisition: Promise<EmulatorStartLease>): Promise<EmulatorStartLease> {
    this.pendingHelperAcquires.add(acquisition)
    try {
      return await acquisition
    } finally {
      this.pendingHelperAcquires.delete(acquisition)
    }
  }

  destroyAllSessions(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }
    this.shutdownStarted = true
    this.shutdownPromise = this.destroyAllSessionsInternal()
    return this.shutdownPromise
  }

  private async destroyAllSessionsInternal(): Promise<void> {
    const promises: Promise<unknown>[] = []
    for (const session of this.options.sessionRegistry.listSessions()) {
      if (!session.managed) {
        continue
      }
      const backend = this.backendForKind(session.backend)
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
    const pendingHelperAcquires = Promise.allSettled(this.pendingHelperAcquires)
    await Promise.allSettled([
      this.options.startLeases.shutdown(),
      pendingHelperAcquires,
      ...promises
    ])
    this.options.sessionRegistry.clear()
  }

  private backendForKind(kind: EmulatorBackend['kind']): EmulatorBackend | null {
    return this.options.backends.find((backend) => backend.kind === kind) ?? null
  }
}
