import { createConnection, type Socket } from 'node:net'
import type {
  HerdrSocketEvent,
  HerdrSocketTransportOptions,
  Subscription
} from './herdr-socket-types'
import {
  HerdrSocketMessageParser,
  createRequest,
  defaultHerdrSocketPath,
  encodeSocketMessage,
  isSocketEvent,
  isSocketResponse
} from './herdr-socket-connection'

export type HerdrSocketEventConnectionOptions = HerdrSocketTransportOptions & {
  sessionName: string
  subscriptions?: Subscription[]
}

// Subscribe to every global event kind so Orca is a first-class client.
// Per-pane kinds (pane.output_matched, pane.agent_status_changed, pane.scroll_changed)
// require pane_id and are not subscribed globally.
const EVENT_KINDS = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated'
] as const

export const DEFAULT_HERDR_EVENT_SUBSCRIPTIONS: Subscription[] = EVENT_KINDS.map((type) => ({
  type
}))

const CONNECT_TIMEOUT_MS = 5000

// A subscribed socket connection stays open and pushes events; it rejects
// further requests, so this connection is dedicated to the event stream.
export class HerdrSocketEventConnection {
  private readonly socketPath: string
  private readonly subscriptions: Subscription[]
  private socket: Socket | null = null
  private readonly parser = new HerdrSocketMessageParser()
  private readonly listeners = new Set<(event: HerdrSocketEvent) => void>()
  private readonly reconnection: HerdrSocketReconnection
  private connected = false
  private destroyed = false
  // True once a subscription is established; survives socket errors/drops until
  // disconnect(), so the close handler reconnects even when an 'error' already
  // flipped `connected` back to false.
  private subscribed = false

  constructor(private readonly options: HerdrSocketEventConnectionOptions) {
    this.socketPath = options.socketPath ?? defaultHerdrSocketPath(options.sessionName)
    this.subscriptions = options.subscriptions ?? DEFAULT_HERDR_EVENT_SUBSCRIPTIONS
    this.reconnection = new HerdrSocketReconnection(
      () => this.openAndSubscribe(),
      options.reconnection,
      {
        onMaxAttemptsReached: (error) => {
          console.error('[herdr] Event connection gave up reconnecting:', error.message)
        }
      }
    )
  }

  isConnected(): boolean {
    return this.connected
  }

  onEvent(listener: (event: HerdrSocketEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (this.connected || this.destroyed) {
      return
    }
    this.subscribed = false
    this.reconnection.reset()
    await this.openAndSubscribe()
  }

  async disconnect(): Promise<void> {
    this.destroyed = true
    this.subscribed = false
    this.reconnection.cancel()
    this.closeSocket()
    this.listeners.clear()
  }

  private closeSocket(): void {
    this.connected = false
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.parser.reset()
  }

  private async openAndSubscribe(): Promise<void> {
    const socketPath = this.socketPath
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const parser = this.parser
      const socket = createConnection(socketPath)
      this.socket = socket

      const connectTimer = setTimeout(() => {
        finish(new Error(`Event connection to ${socketPath} timed out`))
      }, this.options.timeoutMs ?? CONNECT_TIMEOUT_MS)

      const finish = (error: Error | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(connectTimer)
        if (error) {
          this.closeSocket()
          reject(error)
        } else {
          resolve()
        }
      }

      const request = createRequest('events.subscribe', { subscriptions: this.subscriptions })

      socket.once('connect', () => {
        socket.write(encodeSocketMessage(request), (error) => {
          if (error) {
            finish(error)
          }
        })
      })

      socket.on('data', (chunk: Buffer) => {
        for (const message of parser.feed(chunk.toString('utf8'))) {
          if (isSocketResponse(message) && message.id === request.id) {
            if (message.error) {
              finish(new Error(message.error.message))
            } else {
              this.connected = true
              this.subscribed = true
              finish(null)
            }
            continue
          }
          if (isSocketEvent(message)) {
            this.dispatch(message)
          }
        }
      })

      socket.once('error', (error: Error) => {
        finish(error)
      })

      socket.once('close', () => {
        const wasSubscribed = this.subscribed
        this.connected = false
        if (!settled) {
          finish(new Error(`Event connection to ${socketPath} closed before subscription started`))
          return
        }
        if (wasSubscribed && !this.destroyed) {
          this.reconnection.attemptReconnection().catch((error) => {
            console.error(
              '[herdr] Event reconnect failed:',
              error instanceof Error ? error.message : error
            )
          })
        }
      })
    })
  }

  private dispatch(event: HerdrSocketEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[herdr] Event listener error:', error)
      }
    }
  }
}

export type ReconnectionConfig = {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
  factor: number
}

export const DEFAULT_RECONNECTION_CONFIG = {
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
  factor: 2
} as const

export type ReconnectionState = {
  attempt: number
  nextDelayMs: number
  lastAttemptTime: number
  timer: NodeJS.Timeout | null
}

export class HerdrSocketReconnection {
  private state: ReconnectionState = {
    attempt: 0,
    nextDelayMs: 0,
    lastAttemptTime: 0,
    timer: null
  }

  private config: ReconnectionConfig
  private connectFn: () => Promise<void>
  private onReconnecting?: (attempt: number, delayMs: number) => void
  private onReconnected?: () => void
  private onMaxAttemptsReached?: (error: Error) => void
  private cancelled = false

  constructor(
    connectFn: () => Promise<void>,
    config?: Partial<ReconnectionConfig>,
    callbacks?: {
      onReconnecting?: (attempt: number, delayMs: number) => void
      onReconnected?: () => void
      onMaxAttemptsReached?: (error: Error) => void
    }
  ) {
    this.connectFn = connectFn
    this.config = { ...DEFAULT_RECONNECTION_CONFIG, ...config }
    this.onReconnecting = callbacks?.onReconnecting
    this.onReconnected = callbacks?.onReconnected
    this.onMaxAttemptsReached = callbacks?.onMaxAttemptsReached
  }

  async attemptReconnection(): Promise<void> {
    if (this.cancelled) {
      return
    }
    if (!this.config.enabled) {
      throw new ReconnectionCancelledError('Reconnection is disabled')
    }
    if (this.state.attempt >= this.config.maxAttempts) {
      const error = new Error(`Max reconnection attempts (${this.config.maxAttempts}) reached`)
      this.onMaxAttemptsReached?.(error)
      throw error
    }
    this.state.attempt++
    this.state.nextDelayMs = Math.min(
      this.config.initialDelayMs * this.config.factor ** (this.state.attempt - 1),
      this.config.maxDelayMs
    )
    this.onReconnecting?.(this.state.attempt, this.state.nextDelayMs)
    await this.sleep(this.state.nextDelayMs)
    if (this.cancelled) {
      return
    }
    try {
      await this.connectFn()
      this.state.attempt = 0
      this.state.nextDelayMs = 0
      this.onReconnected?.()
    } catch {
      if (this.cancelled) {
        return
      }
      await this.attemptReconnection()
    }
  }

  private sleepResolve: (() => void) | null = null

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepResolve = resolve
      this.state.timer = setTimeout(() => {
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }

  cancel(): void {
    this.cancelled = true
    if (this.state.timer) {
      clearTimeout(this.state.timer)
      this.state.timer = null
    }
    const resolve = this.sleepResolve
    this.sleepResolve = null
    resolve?.()
  }

  reset(): void {
    this.cancelled = false
    this.state = {
      attempt: 0,
      nextDelayMs: 0,
      lastAttemptTime: 0,
      timer: null
    }
  }

  isReconnecting(): boolean {
    return this.state.attempt > 0
  }

  getAttemptCount(): number {
    return this.state.attempt
  }

  getNextDelayMs(): number {
    return this.state.nextDelayMs
  }
}

export class ReconnectionCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconnectionCancelledError'
  }
}
