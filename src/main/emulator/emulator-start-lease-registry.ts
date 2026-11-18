import type { EmulatorBackend } from './backends/emulator-backend'
import type { EmulatorSessionInfo } from './emulator-types'
import { EmulatorError } from './emulator-errors'

export type EmulatorStartLease = {
  info: EmulatorSessionInfo
  release(options?: { cleanupIfUnused?: boolean }): Promise<void>
}

type CleanupOptions = {
  includeOrphaned?: boolean
  shutdownDevice?: boolean
  releaseOnShutdownFailure?: boolean
  force?: boolean
  validate?: () => void
}

type PendingCleanup = {
  info: EmulatorSessionInfo
  isRegistered: (info: EmulatorSessionInfo) => boolean
  options: CleanupOptions
  resolve: () => void
  reject: (error: unknown) => void
}

export class EmulatorStartLeaseRegistry {
  private readonly claimsByBackend = new Map<EmulatorBackend, number>()
  private readonly cleanupByBackend = new Map<EmulatorBackend, Promise<void>>()
  private readonly pendingCleanupByBackend = new Map<
    EmulatorBackend,
    Map<string, PendingCleanup[]>
  >()
  private closed = false
  private readonly idleWaiters = new Set<() => void>()

  async acquire(
    backend: EmulatorBackend,
    device: string,
    isRegistered: (info: EmulatorSessionInfo) => boolean
  ): Promise<EmulatorStartLease> {
    if (this.closed) {
      throw new EmulatorError('emulator_error', 'Emulator shutdown is in progress.')
    }
    this.claimsByBackend.set(backend, (this.claimsByBackend.get(backend) ?? 0) + 1)
    try {
      await this.cleanupByBackend.get(backend)
      if (this.closed) {
        throw new EmulatorError('emulator_error', 'Emulator shutdown is in progress.')
      }
      const info = await backend.startSession(device, () => this.assertOpen())
      this.assertOpen()
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

  assertOpen(): void {
    if (this.closed) {
      throw new EmulatorError('emulator_error', 'Emulator shutdown is in progress.')
    }
  }

  async closeAndDrain(): Promise<void> {
    this.closed = true
    if (this.claimsByBackend.size) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
    }
    for (const backend of this.pendingCleanupByBackend.keys()) {
      await this.drainCleanup(backend)
    }
    await Promise.all(this.cleanupByBackend.values())
  }

  async cleanupWhenIdle(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: CleanupOptions = {}
  ): Promise<void> {
    const completion = this.queueCleanup(backend, info, isRegistered, options)
    await this.drainCleanup(backend)
    await completion
  }

  private queueCleanup(
    backend: EmulatorBackend,
    info: EmulatorSessionInfo,
    isRegistered: (info: EmulatorSessionInfo) => boolean,
    options: CleanupOptions
  ): Promise<void> {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const completion = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    void completion.catch(() => {})
    const pending = this.pendingCleanupByBackend.get(backend) ?? new Map<string, PendingCleanup[]>()
    const requests = pending.get(info.deviceUdid) ?? []
    requests.push({ info, isRegistered, options, resolve, reject })
    pending.set(info.deviceUdid, requests)
    this.pendingCleanupByBackend.set(backend, pending)
    return completion
  }

  private async release(backend: EmulatorBackend, ownCleanup?: Promise<void>): Promise<void> {
    const remaining = (this.claimsByBackend.get(backend) ?? 1) - 1
    if (remaining > 0) {
      this.claimsByBackend.set(backend, remaining)
      return
    }
    this.claimsByBackend.delete(backend)
    await this.drainCleanup(backend)
    if (!this.claimsByBackend.size) {
      for (const resolve of this.idleWaiters) {
        resolve()
      }
      this.idleWaiters.clear()
    }
    await ownCleanup
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
    const cleanup = Promise.all(
      [...pending.values()].map((requests) => this.runDeviceCleanup(backend, requests))
    )
      .then(() => {})
      .finally(() => this.cleanupByBackend.delete(backend))
    this.cleanupByBackend.set(backend, cleanup)
    await cleanup
  }

  private async runDeviceCleanup(
    backend: EmulatorBackend,
    requests: PendingCleanup[]
  ): Promise<void> {
    const groups = new Map<string, PendingCleanup[]>()
    for (const [index, request] of requests.entries()) {
      const { info } = request
      const identity = backend.kind === 'android' ? info.instanceId : info.helperPid
      const key =
        identity === undefined
          ? `unknown:${index}`
          : JSON.stringify([identity, info.streamUrl, info.wsUrl])
      const group = groups.get(key) ?? []
      group.push(request)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const eligible: PendingCleanup[] = []
      for (const request of group) {
        try {
          request.options.validate?.()
          if (request.options.force || !request.isRegistered(request.info)) {
            eligible.push(request)
          } else {
            request.resolve()
          }
        } catch (error) {
          request.reject(error)
        }
      }
      if (!eligible.length) {
        continue
      }
      const info = eligible[0].info
      try {
        await backend.stopHelperForDevice(info.deviceUdid, {
          helperPid: info.helperPid,
          instanceId: info.instanceId,
          requireInstanceId: backend.kind === 'android',
          includeOrphaned: eligible.some((request) => request.options.includeOrphaned),
          shutdownDevice: eligible.some((request) => request.options.shutdownDevice),
          releaseOnShutdownFailure: eligible.some(
            (request) => request.options.releaseOnShutdownFailure
          )
        })
        for (const request of eligible) {
          request.resolve()
        }
      } catch (error) {
        for (const request of eligible) {
          request.reject(error)
        }
      }
    }
  }
}
