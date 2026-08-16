import crypto from 'node:crypto'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalController,
  HerdrTerminalControlOptions,
  HerdrTransportEvent
} from './herdr-runtime-contract'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import { HerdrTransport } from './herdr-transport'
import {
  createHerdrDaemonTerminalController,
  type HerdrDaemonPaneData
} from './herdr-daemon-terminal-control'
import { DEFAULT_HERDR_EVENT_SUBSCRIPTIONS } from './herdr-socket-events'
import type { HerdrSocketEvent } from './herdr-socket-types'

// Why: local transport that talks to the in-app daemon over its single socket
// instead of spawning the stock herdr binary. The daemon serves the full
// protocol-19 surface on HerdrTransport.getDefaultSocketPath(); this transport
// keeps one persistent connection for both requests and events (the daemon
// pushes {event,data} frames to subscribed connections on the same socket).
export class HerdrDaemonHostTransport implements HerdrHostTransport {
  private readonly client: HerdrTransport
  private readonly eventListeners = new Set<(event: HerdrTransportEvent) => void>()
  private readonly paneDataListeners = new Set<(payload: HerdrDaemonPaneData) => void>()
  private ready = false
  private ensurePromise: Promise<void> | null = null

  constructor(socketPath?: string) {
    this.client = new HerdrTransport(socketPath ?? HerdrTransport.getDefaultSocketPath())
    // Why: socket errors (EPIPE on disconnect, ECONNREFUSED if the daemon is
    // restarting) must not crash the host; ensureSession surfaces real failures.
    this.client.on('error', () => {})
  }

  async ensureSession(_sessionName: string): Promise<void> {
    if (this.ready) {
      return
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.doEnsure()
    }
    try {
      await this.ensurePromise
    } finally {
      this.ensurePromise = null
    }
  }

  private async doEnsure(): Promise<void> {
    await this.client.connect()
    this.client.on('event', (event: HerdrSocketEvent) => {
      for (const listener of this.eventListeners) {
        listener(event)
      }
    })
    this.client.on('notification', (notification: { method: string; params: unknown }) => {
      if (notification.method !== 'pane.data') {
        return
      }
      const payload = notification.params as HerdrDaemonPaneData
      for (const listener of this.paneDataListeners) {
        listener(payload)
      }
    })
    await this.client.request('ping', {})
    await this.client.request('session.snapshot', {})
    await this.client.request('events.subscribe', {
      subscriptions: DEFAULT_HERDR_EVENT_SUBSCRIPTIONS
    })
    this.ready = true
  }

  async request<T>(
    _sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    try {
      const result = await this.client.request(method, params)
      return { id: crypto.randomUUID(), result: result as T }
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        error: {
          code: error instanceof HerdrRuntimeError ? error.code : 'herdr_request_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  controlTerminal(
    _sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    return createHerdrDaemonTerminalController(target, options, {
      request: <T>(method: string, params: unknown) =>
        this.client.request(method, params) as Promise<T>,
      subscribePaneData: (listener) => this.onPaneData(listener),
      subscribeEvents: (listener) => this.onEvent(listener)
    })
  }

  onEvent(listener: (event: HerdrTransportEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onPaneData(listener: (payload: HerdrDaemonPaneData) => void): () => void {
    this.paneDataListeners.add(listener)
    return () => this.paneDataListeners.delete(listener)
  }

  async disconnect(): Promise<void> {
    this.eventListeners.clear()
    this.paneDataListeners.clear()
    this.ready = false
    await this.client.close()
  }
}
