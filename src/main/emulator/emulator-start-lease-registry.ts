import { EmulatorError } from './emulator-errors'
import type { EmulatorBackend } from './backends/emulator-backend'
import type { EmulatorSessionInfo } from './emulator-types'

export type EmulatorStartLease = {
  info: EmulatorSessionInfo
  release(options?: { cleanupIfUnused?: boolean }): Promise<void>
}

type PendingCleanup = {
  info: EmulatorSessionInfo
  isRegistered: (info: EmulatorSessionInfo) => boolean
  includeOrphaned: boolean
  shutdownDevice: boolean
}

type ActiveLease = {
  backend: EmulatorBackend
  info: EmulatorSessionInfo
  isRegistered: (info: EmulatorSessionInfo) => boolean
  released: boolean
}

export class EmulatorStartLeaseRegistry {
  private readonly claimsByBackend = new Map<EmulatorBackend, number>()
  private readonly cleanupByBackend = new Map<EmulatorBackend, Promise<void>>()
  private readonly pendingCleanupByBackend = new Map<EmulatorBackend, Map<string, PendingCleanup>>()
  private readonly activeLeases = new Set<ActiveLease>()
  private readonly inFlightAcquires = new Set<Promise<EmulatorStartLease>>()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | undefined

  acquire(
    backend: EmulatorBackend,
    device: string,
    isRegistered: (info: EmulatorSessionInfo) => boolean
  ): Promise<EmulatorStartLease> {
    if (this.shutdownStarted) {
      return Promise.reject(createShutdownError())
    }
    const operation = this.acquireInternal(backend, device, isRegistered)
    this.inFlightAcquires.add(operation)
    void operation.then(
      () => this.inFlightAcquires.delete(operation),
      () => this.inFlightAcquires.delete(operation)
    )
    return operation
  }

  private async acquireInternal(
    backend: EmulatorBackend,
    device: string,
    isRegistered: (info: EmulatorSessionInfo) => boolean
  ): Promise<EmulatorStartLease> {
    this.claimsByBackend.set(backend, (this.claimsByBackend.get(backend) ?? 0) + 1)
    try {
      await this.cleanupByBackend.get(backend)
      if (this.shutdownStarted) {
        throw createShutdownError()
      }
      const info = await backend.startSession(device)
      if (this.shutdownStarted) {
        await this.cleanupStartedSession(backend, info)
        throw createShutdownError()
      }
      const activeLease: ActiveLease = {
        backend,
        info,
        isRegistered,
        released: false
      }
      this.activeLeases.add(activeLease)
      return {
        info,
        release: (options = {}) => this.releaseActiveLease(activeLease, options)
      }
    } catch (error) {
      await this.release(backend)
      throw error
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }
    this.shutdownStarted = true
    this.shutdownPromise = this.shutdownActiveLeases()
    return this.shutdownPromise
  }

  private async shutdownActiveLeases(): Promise<void> {
    await Promise.allSettled(this.inFlightAcquires)
    const leases = [...this.activeLeases]
    await Promise.allSettled(
      leases.map((lease) =>
        this.releaseActiveLease(lease, {
          cleanupIfUnused: !lease.isRegistered(lease.info)
        })
      )
    )
    await Promise.allSettled(this.cleanupByBackend.values())
  }

  async cleanupWhenIdle(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: { includeOrphaned?: boolean; shutdownDevice?: boolean } = {}
  ): Promise<void> {
    this.addPendingCleanup(backend, info, isRegistered, options)
    await this.drainCleanup(backend)
  }

  private async release(backend: EmulatorBackend): Promise<void> {
    const remaining = this.decrement(backend)
    if (remaining > 0) {
      return
    }
    await this.drainCleanup(backend)
  }

  private async releaseActiveLease(
    lease: ActiveLease,
    options: { cleanupIfUnused?: boolean } = {}
  ): Promise<void> {
    if (lease.released) {
      return
    }
    lease.released = true
    this.activeLeases.delete(lease)
    if (options.cleanupIfUnused) {
      this.addPendingCleanup(lease.backend, lease.info, lease.isRegistered, {
        includeOrphaned: true,
        shutdownDevice: true
      })
    }
    await this.release(lease.backend)
  }

  private async cleanupStartedSession(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo
  ): Promise<void> {
    await backend
      .stopHelperForDevice(info.deviceUdid, {
        helperPid: info.helperPid,
        includeOrphaned: true
      })
      .catch(() => {})
    await backend.shutdownDevice(info.deviceUdid).catch(() => {})
  }

  private async drainCleanup(backend: EmulatorBackend): Promise<void> {
    await this.cleanupByBackend.get(backend)
    if ((this.claimsByBackend.get(backend) ?? 0) > 0) {
      return
    }
    const pending = this.pendingCleanupByBackend.get(backend)
    this.pendingCleanupByBackend.delete(backend)
    if (!pending) {
      return
    }
    const cleanup = Promise.allSettled(
      [...pending.values()].map(async ({ info, isRegistered, includeOrphaned, shutdownDevice }) => {
        if (isRegistered(info)) {
          return
        }
        await backend.stopHelperForDevice(info.deviceUdid, {
          helperPid: info.helperPid,
          includeOrphaned
        })
        if (shutdownDevice) {
          await backend.shutdownDevice(info.deviceUdid)
        }
      })
    )
      .then(() => undefined)
      .finally(() => this.cleanupByBackend.delete(backend))
    this.cleanupByBackend.set(backend, cleanup)
    await cleanup
  }

  private addPendingCleanup(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: { includeOrphaned?: boolean; shutdownDevice?: boolean }
  ): void {
    const pending = this.pendingCleanupByBackend.get(backend) ?? new Map()
    const existing = pending.get(info.deviceUdid)
    pending.set(info.deviceUdid, {
      info,
      isRegistered,
      includeOrphaned: options.includeOrphaned === true || existing?.includeOrphaned === true,
      shutdownDevice: options.shutdownDevice === true || existing?.shutdownDevice === true
    })
    this.pendingCleanupByBackend.set(backend, pending)
  }

  private decrement(backend: EmulatorBackend): number {
    const next = Math.max(0, (this.claimsByBackend.get(backend) ?? 1) - 1)
    if (next === 0) {
      this.claimsByBackend.delete(backend)
    } else {
      this.claimsByBackend.set(backend, next)
    }
    return next
  }
}

function createShutdownError(): EmulatorError {
  return new EmulatorError('emulator_no_active', 'Emulator runtime is shutting down')
}
