import { createConnection, type Socket } from 'node:net'
import type {
  HerdrSocketEvent,
  HerdrSocketTransportOptions,
  Subscription
} from './herdr-socket-types'
import {
  HerdrSocketMessageParser,
  createRequest,
  encodeSocketMessage,
  isSocketEvent,
  isSocketResponse
} from './herdr-socket-message'
import { HerdrSocketReconnection } from './herdr-socket-reconnection'
import { defaultHerdrSocketPath } from './herdr-socket-connection'

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
