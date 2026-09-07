import { elapsedMs, monotonicNowMs } from './monotonic-clock'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionState } from './types'

type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

type ConnectionStateOptions = {
  endpoint: string
  initialListener?: (state: ConnectionState) => void
  getReconnectAttempt: () => number
  isClosed: () => boolean
  onStateDwell?: (previous: ConnectionState, next: ConnectionState, dweltMs: number) => void
  now?: () => number
}

export class RpcClientConnectionState {
  private state: ConnectionState = 'disconnected'
  private lastConnectedAt: number | null = null
  private stateEnteredAt: number
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private readonly waiters: ConnectWaiter[] = []

  constructor(private readonly options: ConnectionStateOptions) {
    this.stateEnteredAt = this.now()
    if (options.initialListener) {
      this.listeners.add(options.initialListener)
    }
  }

  get(): ConnectionState {
    return this.state
  }

  getLastConnectedAt(): number | null {
    return this.lastConnectedAt
  }

  publish(next: ConnectionState): void {
    if (this.state === next) {
      return
    }
    const previous = this.state
    const dweltMs = elapsedMs(this.stateEnteredAt, this.now())
    this.state = next
    this.stateEnteredAt = this.now()
    try {
      this.options.onStateDwell?.(previous, next, dweltMs)
    } catch {
      // Diagnostics only; a broken log sink must not abort the state publish.
    }
    console.log('[net] state', {
      from: previous,
      to: next,
      dweltMs,
      attempt: this.options.getReconnectAttempt(),
      endpoint: redactSocketEndpoint(this.options.endpoint)
    })
    if (next === 'connected') {
      this.lastConnectedAt = Date.now()
      this.resolveWaiters()
    } else if (next === 'disconnected' || next === 'auth-failed') {
      this.rejectWaiters(
        next === 'auth-failed' ? 'Unauthorized — pairing may be revoked' : 'Connection closed'
      )
    }
    for (const listener of this.listeners) {
      listener(next)
    }
  }

  waitForConnected(timeoutMs?: number): Promise<void> {
    if (this.state === 'connected') {
      return Promise.resolve()
    }
    if (this.options.isClosed()) {
      return Promise.reject(new Error('Client closed'))
    }
    return new Promise((resolve, reject) => {
      const waiter: ConnectWaiter = { resolve, reject, timeout: null }
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter)
            if (index !== -1) {
              this.waiters.splice(index, 1)
            }
            reject(new Error('Timed out while connecting to the remote Orca runtime.'))
          },
          Math.max(0, timeoutMs)
        )
      }
      this.waiters.push(waiter)
    })
  }

  rejectWaiters(reason: string): void {
    const error = new Error(reason)
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
      waiter.reject(error)
    }
  }

  addListener(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private now(): number {
    return (this.options.now ?? monotonicNowMs)()
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
      waiter.resolve()
    }
  }
}
