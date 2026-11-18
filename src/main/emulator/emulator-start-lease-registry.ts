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
  waiters: { resolve: () => void; reject: (error: unknown) => void }[]
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
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const completion = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    void completion.catch(() => {})
    this.addPendingCleanup(backend, info, isRegistered, options, { resolve, reject })
    await this.drainCleanup(backend).catch(() => {})
    await completion
  }

  private async release(backend: EmulatorBackend): Promise<void> {
    const remaining = this.decrement(backend)
    if (remaining > 0) {
      return
    }
    await this.drainCleanup(backend)
  }

  private async drainCleanup(backend: EmulatorBackend): Promise<void> {
    await this.cleanupByBackend.get(backend)?.catch(() => {})
    if ((this.claimsByBackend.get(backend) ?? 0) > 0) {
      return
    }
    const pending = this.pendingCleanupByBackend.get(backend)
    this.pendingCleanupByBackend.delete(backend)
    if (!pending) {
      return
    }
    const cleanup = Promise.allSettled(
      [...pending.values()].map(
        async ({ info, isRegistered, includeOrphaned, shutdownDevice, waiters }) => {
          try {
            if (!isRegistered(info)) {
              await backend.stopHelperForDevice(info.deviceUdid, {
                helperPid: info.helperPid,
                includeOrphaned,
                shutdownDevice
              })
            }
            for (const waiter of waiters) {
              waiter.resolve()
            }
          } catch (error) {
            for (const waiter of waiters) {
              waiter.reject(error)
            }
            throw error
          }
        }
      )
    )
      .then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          throw failure.reason
        }
      })
      .finally(() => this.cleanupByBackend.delete(backend))
    this.cleanupByBackend.set(backend, cleanup)
    await cleanup
  }

  private addPendingCleanup(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: { includeOrphaned?: boolean; shutdownDevice?: boolean },
    waiter?: { resolve: () => void; reject: (error: unknown) => void }
  ): void {
    const pending = this.pendingCleanupByBackend.get(backend) ?? new Map()
    const existing = pending.get(info.deviceUdid)
    pending.set(info.deviceUdid, {
      info,
      isRegistered,
      includeOrphaned: options.includeOrphaned === true || existing?.includeOrphaned === true,
      shutdownDevice: options.shutdownDevice === true || existing?.shutdownDevice === true,
      waiters: [...(existing?.waiters ?? []), ...(waiter ? [waiter] : [])]
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
