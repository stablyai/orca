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

export class EmulatorStartLeaseRegistry {
  private readonly claimsByBackend = new Map<EmulatorBackend, number>()
  private readonly cleanupByBackend = new Map<EmulatorBackend, Promise<void>>()
  private readonly pendingCleanupByBackend = new Map<EmulatorBackend, Map<string, PendingCleanup>>()

  async acquire(
    backend: EmulatorBackend,
    device: string,
    isRegistered: (info: EmulatorSessionInfo) => boolean
  ): Promise<EmulatorStartLease> {
    this.claimsByBackend.set(backend, (this.claimsByBackend.get(backend) ?? 0) + 1)
    try {
      await this.cleanupByBackend.get(backend)
      const info = await backend.startSession(device)
      let released = false
      return {
        info,
        release: async (options = {}) => {
          if (released) {
            return
          }
          released = true
          if (options.cleanupIfUnused) {
            this.addPendingCleanup(backend, info, isRegistered, {
              includeOrphaned: true,
              shutdownDevice: true
            })
          }
          await this.release(backend)
        }
      }
    } catch (error) {
      await this.release(backend)
      throw error
    }
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
