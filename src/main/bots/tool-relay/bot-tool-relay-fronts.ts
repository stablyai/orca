// The daemon-held fronts this app answers for. A launch takes its front from the daemon start its
// agent will run on; every start that holds one is served, so agents kept under an older start keep
// their tools. The daemon never dials the app: for each connection it announces, the app opens its own
// authenticated connection to the daemon and the relay's HTTP server takes it in-process.
import type { Socket } from 'node:net'
import type { DaemonClient } from '../../daemon/transport/client/daemon-client'
import {
  TOOL_RELAY_FRONT_EVENT,
  type ToolRelayFrontOpenResult,
  type ToolRelayFrontServeResult
} from '../../daemon/protocol/daemon-tool-relay-front-protocol'
import { openDaemonToolRelayConnection } from '../../daemon/transport/client/daemon-client-tool-relay-connection'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { providerRelayRoute } from '../../provider-relay/provider-relay-route'
import { keptProviderRelay } from '../../provider-relay/provider-relay-launch-inventory'

const CONNECT_TIMEOUT_MS = 1_000
const FRONT_REQUEST_TIMEOUT_MS = 5_000

/** A launch's front: its loopback origin and the daemon start holding it. */
export type ToolRelayFront = { origin: string; daemonInstance: string }

type Watched = {
  stop: () => void
  port: number | null
  /** The latest serve request; announcements wait for it, so the Host check knows the port. */
  served: Promise<unknown>
  /** Bumped by each hello: a connection serves once, however many chats launch on it. */
  connection: number
  servedConnection: number | null
  /** Announced connections being opened, so a re-announcement starts no second one. */
  opening: Set<string>
}

export class ToolRelayFronts {
  private readonly watched = new Map<DaemonClient, Watched>()
  private closed = false

  constructor(private readonly accept: (socket: Socket) => void) {}

  /**
   * The front of the daemon start `chatKey`'s agent runs on: the one its kept agent runs under, or
   * the one new agents go to. Null where there is none (an older daemon, Windows, a remote host).
   */
  async current(chatKey: string): Promise<ToolRelayFront | null> {
    const route = providerRelayRoute()
    if (!route || this.closed) {
      return null
    }
    const kept = keptProviderRelay(chatKey)
    const client = kept ? kept.channel.client : await route.current().catch(() => null)
    if (!client || !(await connected(client)) || !client.getDaemonIdentity()?.toolRelayFront) {
      return null
    }
    this.watch(client)
    try {
      const { port, daemonInstance } = await client.request<ToolRelayFrontOpenResult>(
        'toolRelayFrontOpen',
        undefined,
        FRONT_REQUEST_TIMEOUT_MS
      )
      if (!Number.isSafeInteger(port) || typeof daemonInstance !== 'string') {
        return null
      }
      this.noteServed(client, port)
      // Served before handing the address out, so its first call has an app to answer it.
      await this.serveOnce(client)
      return { origin: `http://127.0.0.1:${port}`, daemonInstance }
    } catch {
      return null
    }
  }

  /** Answers every daemon start's front, from each hello on (agents kept by older ones too). */
  async serveAll(): Promise<void> {
    const route = providerRelayRoute()
    if (!route || this.closed) {
      return
    }
    for (const client of await route.all().catch(() => [])) {
      this.watch(client)
      if (await connected(client)) {
        await this.serveOnce(client).catch(() => {})
      }
    }
  }

  /** A Host header the relay may answer: one of the fronts it serves. */
  serves(port: number): boolean {
    for (const watched of this.watched.values()) {
      if (watched.port === port) {
        return true
      }
    }
    return false
  }

  close(): void {
    this.closed = true
    for (const watched of this.watched.values()) {
      watched.stop()
    }
    this.watched.clear()
  }

  private watch(client: DaemonClient): void {
    if (this.watched.has(client) || this.closed) {
      return
    }
    const stopEvents = client.onEvent((event) => {
      if (jsonProperty(event, 'event') !== TOOL_RELAY_FRONT_EVENT) {
        return
      }
      const id = jsonProperty(jsonProperty(event, 'payload'), 'frontConnectionId')
      if (typeof id === 'string') {
        void this.answer(client, id)
      }
    })
    // Each hello (a reconnect, or a new daemon start under the same client) serves again.
    const stopConnected = client.connectedListeners.add(() => {
      const watched = this.watched.get(client)
      if (watched) {
        watched.connection += 1
      }
      void this.serveOnce(client).catch(() => {})
    })
    this.watched.set(client, {
      port: null,
      served: Promise.resolve(),
      connection: 0,
      servedConnection: null,
      opening: new Set(),
      stop: () => {
        stopEvents()
        stopConnected()
      }
    })
  }

  /** Registers this app as the front's server, once per connection to that daemon start. */
  private async serveOnce(client: DaemonClient): Promise<void> {
    const watched = this.watched.get(client)
    if (!client.getDaemonIdentity()?.toolRelayFront || this.closed || !watched) {
      return
    }
    if (watched.servedConnection === watched.connection) {
      await watched.served
      return
    }
    watched.servedConnection = watched.connection
    const served = client
      .request<ToolRelayFrontServeResult>(
        'toolRelayFrontServe',
        undefined,
        FRONT_REQUEST_TIMEOUT_MS
      )
      .then(({ port }) => this.noteServed(client, Number.isSafeInteger(port) ? port : null))
    watched.served = served.catch(() => {
      // A failed serve is asked again by the next launch.
      if (watched.servedConnection === watched.connection) {
        watched.servedConnection = null
      }
    })
    await served
  }

  private noteServed(client: DaemonClient, port: number | null): void {
    const watched = this.watched.get(client)
    if (watched) {
      watched.port = port
    }
  }

  private async answer(client: DaemonClient, frontConnectionId: string): Promise<void> {
    const watched = this.watched.get(client)
    if (this.closed || !watched || watched.opening.has(frontConnectionId)) {
      return
    }
    watched.opening.add(frontConnectionId)
    try {
      // The daemon re-announces held connections while it answers the serve request.
      await watched.served
      const { socket, remainder } = await openDaemonToolRelayConnection(client, frontConnectionId)
      // Closed meanwhile: a late connection is never served.
      if (this.closed) {
        socket.destroy()
        return
      }
      if (remainder.length > 0) {
        socket.unshift(remainder)
      }
      this.accept(socket)
    } catch {
      // The daemon answers the held connection itself once its hold runs out.
    } finally {
      watched.opening.delete(frontConnectionId)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}

async function connected(client: DaemonClient): Promise<boolean> {
  try {
    await client.ensureConnectedWithin(CONNECT_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}
