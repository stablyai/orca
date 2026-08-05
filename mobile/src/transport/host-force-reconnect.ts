import type { RpcClient } from './rpc-client'
import {
  FORCE_RECONNECT_TIMEOUT_MS,
  verifyForceReconnectRpcHealth
} from './force-reconnect-rpc-health'

export type HostReconnectEntry = {
  client: RpcClient
  refCount: number
  unsubState: () => void
}

type HostReconnectOperation = {
  hostId: string
  profileVersion: number
  getEntry: () => HostReconnectEntry | undefined
  getListenerCount: () => number
  removeEntry: (expected: HostReconnectEntry) => void
  cancelPendingOpen: () => void
  openReplacement: () => Promise<HostReconnectEntry | null>
}

type PendingReconnect = {
  profileVersion: number
  generation: number
  promise: Promise<void>
  cancel: () => void
}

export class HostForceReconnectCoordinator {
  private readonly pendingByHost = new Map<string, PendingReconnect>()
  private readonly generations = new Map<string, number>()

  cancel(hostId: string): void {
    this.generations.set(hostId, this.generation(hostId) + 1)
    this.pendingByHost.get(hostId)?.cancel()
    this.pendingByHost.delete(hostId)
  }

  cancelAll(): void {
    for (const hostId of this.pendingByHost.keys()) {
      this.cancel(hostId)
    }
  }

  run(operation: HostReconnectOperation): Promise<void> {
    const pending = this.pendingByHost.get(operation.hostId)
    let generation = this.generation(operation.hostId)
    if (pending?.profileVersion === operation.profileVersion && pending.generation === generation) {
      return pending.promise
    }
    if (pending) {
      generation += 1
      this.generations.set(operation.hostId, generation)
      pending.cancel()
    }
    // Why: a first reconnect must not join an ordinary open whose Keychain read may never settle.
    operation.cancelPendingOpen()
    let cancelReconnect: () => void = () => {}
    const cancelled = new Promise<void>((resolve) => {
      cancelReconnect = () => {
        operation.cancelPendingOpen()
        resolve()
      }
    })
    const reconnect = this.replaceAndVerify(
      operation,
      generation,
      Date.now() + FORCE_RECONNECT_TIMEOUT_MS,
      cancelled
    )
    this.pendingByHost.set(operation.hostId, {
      profileVersion: operation.profileVersion,
      generation,
      promise: reconnect,
      cancel: cancelReconnect
    })
    const clearPending = () => {
      if (this.pendingByHost.get(operation.hostId)?.promise === reconnect) {
        this.pendingByHost.delete(operation.hostId)
      }
    }
    void reconnect.then(clearPending, clearPending)
    return reconnect
  }

  private async replaceAndVerify(
    operation: HostReconnectOperation,
    generation: number,
    deadline: number,
    cancelled: Promise<void>
  ): Promise<void> {
    if (this.wasCancelled(operation.hostId, generation)) {
      return
    }
    const entry = operation.getEntry()
    const savedRefCount = entry?.refCount ?? Math.max(1, operation.getListenerCount())
    if (entry) {
      this.retireCurrentEntry(operation, entry)
    }
    const fresh = await this.openBeforeDeadline(operation, deadline, cancelled)
    if (this.wasCancelled(operation.hostId, generation)) {
      return
    }
    if (!fresh) {
      throw new Error('Unable to open a replacement connection')
    }
    fresh.refCount = savedRefCount
    try {
      await verifyForceReconnectRpcHealth(fresh.client, deadline)
    } catch (error) {
      // Why: report the unhealthy verdict but keep the replacement — retiring it
      // strands the host with no client, no retry loop, and a 'Disconnected'
      // verdict that hides the Reconnect button the user needs to try again.
      if (!this.wasCancelled(operation.hostId, generation)) {
        throw error
      }
    }
  }

  private retireCurrentEntry(
    operation: HostReconnectOperation,
    expected: HostReconnectEntry
  ): void {
    if (operation.getEntry() !== expected) {
      return
    }
    expected.unsubState()
    expected.client.close()
    operation.removeEntry(expected)
  }

  private async openBeforeDeadline(
    operation: HostReconnectOperation,
    deadline: number,
    cancelled: Promise<void>
  ): Promise<HostReconnectEntry | null> {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      throw new Error('Force Reconnect timed out')
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        operation.openReplacement(),
        cancelled.then(() => null),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            operation.cancelPendingOpen()
            reject(new Error('Force Reconnect timed out'))
          }, timeoutMs)
        })
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private generation(hostId: string): number {
    return this.generations.get(hostId) ?? 0
  }

  private wasCancelled(hostId: string, generation: number): boolean {
    return this.generation(hostId) !== generation
  }
}
