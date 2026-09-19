import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

export type BrowserNetworkTunnelPublicationDrain = {
  drain: (signal: AbortSignal) => Promise<void>
  assertDrained: () => void
}

export class BrowserNetworkTunnelDrainState {
  private pending = 0
  private fenced = false
  private failure: Error | undefined
  private readonly observers = new Set<() => void>()

  constructor(private readonly isLocallySettled: () => boolean) {}

  get admissionClosed(): boolean {
    return this.fenced
  }

  changed(): void {
    for (const notify of this.observers) {
      notify()
    }
  }

  fail(error: Error): void {
    if (this.fenced) {
      this.failure ??= error
      this.changed()
    }
  }

  track(): (error?: Error | null) => void {
    this.pending++
    let settled = false
    return (error) => {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        this.fail(error)
      }
      this.pending--
      this.changed()
    }
  }

  openSocket(open: () => BrowserNetworkTunnelSocket): BrowserNetworkTunnelSocket {
    const settle = this.track()
    try {
      const socket = open()
      socket.on('error', (error) => this.fail(error))
      socket.on('close', () => settle())
      return socket
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  fence(publication: BrowserNetworkTunnelPublicationDrain, closed = false) {
    if (closed) {
      throw new Error('browser_tunnel_closed')
    }
    if (this.fenced) {
      throw new Error('browser_tunnel_already_fenced')
    }
    this.fenced = true
    const assertLocal = () => {
      if (this.failure) {
        throw this.failure
      }
      if (this.pending !== 0 || !this.isLocallySettled()) {
        throw new Error('browser_tunnel_not_drained')
      }
    }
    const assertDrained = () => {
      assertLocal()
      publication.assertDrained()
    }
    return {
      assertDrained,
      drain: async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        while (this.pending !== 0 || !this.isLocallySettled()) {
          if (this.failure) {
            throw this.failure
          }
          const changed = Promise.withResolvers<void>()
          this.observers.add(changed.resolve)
          try {
            await waitForPromiseWithSignal(changed.promise, signal)
          } finally {
            this.observers.delete(changed.resolve)
          }
        }
        assertLocal()
        const failed = Promise.withResolvers<never>()
        const observeFailure = () => {
          if (this.failure) {
            failed.reject(this.failure)
          }
        }
        this.observers.add(observeFailure)
        try {
          await waitForPromiseWithSignal(
            Promise.race([Promise.resolve().then(() => publication.drain(signal)), failed.promise]),
            signal
          )
        } catch (error) {
          if (!signal.aborted) {
            this.fail(error instanceof Error ? error : new Error(String(error)))
          }
          throw error
        } finally {
          this.observers.delete(observeFailure)
        }
        signal.throwIfAborted()
        assertDrained()
      }
    }
  }
}
