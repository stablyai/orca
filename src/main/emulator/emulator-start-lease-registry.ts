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
  releaseOnShutdownFailure: boolean
  force: boolean
  validators: (() => void)[]
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
          const completion = options.cleanupIfUnused
            ? this.queueCleanup(backend, info, isRegistered, {
                includeOrphaned: true,
                shutdownDevice: true
              })
            : undefined
          await this.release(backend, completion)
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
    options: {
      includeOrphaned?: boolean
      shutdownDevice?: boolean
      releaseOnShutdownFailure?: boolean
      force?: boolean
      validate?: () => void
    } = {}
  ): Promise<void> {
    const completion = this.queueCleanup(backend, info, isRegistered, options)
    await this.drainCleanup(backend)
    await completion
  }

  private queueCleanup(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: {
      includeOrphaned?: boolean
      shutdownDevice?: boolean
      releaseOnShutdownFailure?: boolean
      force?: boolean
      validate?: () => void
    }
  ): Promise<void> {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const completion = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    void completion.catch(() => {})
    this.addPendingCleanup(backend, info, isRegistered, options, { resolve, reject })
    return completion
  }

  private async release(backend: EmulatorBackend, ownCleanup?: Promise<void>): Promise<void> {
    const remaining = this.decrement(backend)
    if (remaining > 0) {
      return
    }
    await this.drainCleanup(backend)
    await ownCleanup
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
    const cleanup = Promise.all(
      [...pending.values()].map(
        async ({
          info,
          isRegistered,
          includeOrphaned,
          shutdownDevice,
          releaseOnShutdownFailure,
          force,
          validators,
          waiters
        }) => {
          try {
            for (const validate of validators) {
              validate()
            }
            if (force || !isRegistered(info)) {
              await backend.stopHelperForDevice(info.deviceUdid, {
                helperPid: info.helperPid,
                includeOrphaned,
                shutdownDevice,
                releaseOnShutdownFailure
              })
            }
            for (const waiter of waiters) {
              waiter.resolve()
            }
          } catch (error) {
            for (const waiter of waiters) {
              waiter.reject(error)
            }
          }
        }
      )
    )
      .then(() => {})
      .finally(() => this.cleanupByBackend.delete(backend))
    this.cleanupByBackend.set(backend, cleanup)
    await cleanup
  }

  private addPendingCleanup(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: {
      includeOrphaned?: boolean
      shutdownDevice?: boolean
      releaseOnShutdownFailure?: boolean
      force?: boolean
      validate?: () => void
    },
    waiter?: { resolve: () => void; reject: (error: unknown) => void }
  ): void {
    const pending = this.pendingCleanupByBackend.get(backend) ?? new Map()
    const existing = pending.get(info.deviceUdid)
    pending.set(info.deviceUdid, {
      info: existing?.force ? existing.info : info,
      isRegistered,
      force: options.force === true || existing?.force === true,
      validators: [
        ...(existing?.validators ?? []),
        ...(options.validate ? [options.validate] : [])
      ],
      releaseOnShutdownFailure:
        options.releaseOnShutdownFailure === true || existing?.releaseOnShutdownFailure === true,
      includeOrphaned: options.includeOrphaned === true || existing?.includeOrphaned === true,
      shutdownDevice: existing?.force
        ? existing.shutdownDevice
        : options.force
          ? options.shutdownDevice === true
          : options.shutdownDevice === true || existing?.shutdownDevice === true,
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
