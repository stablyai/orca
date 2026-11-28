// The daemon-held fronts this app answers for. A launch takes its front from the daemon start its
// agent will run on; every start that holds one is served, so agents kept under an older start keep
// their tools. The daemon never dials the app: for each connection it announces, the app opens its own
// authenticated connection to the daemon and the relay's HTTP server takes it in-process.
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { TOOL_RELAY_FRONT_MAX_HELD } from '../../daemon/tool-relay-front/daemon-tool-relay-front'
import type { DaemonClient } from '../../daemon/transport/client/daemon-client'
import {
  TOOL_RELAY_FRONT_EVENT,
  type ToolRelayFrontKeptRelay,
  type ToolRelayFrontOpenResult,
  type ToolRelayFrontServeResult
} from '../../daemon/protocol/daemon-tool-relay-front-protocol'
import { openDaemonToolRelayConnection } from '../../daemon/transport/client/daemon-client-tool-relay-connection'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { providerRelayRoute } from '../../provider-relay/provider-relay-route'
import {
  keptProviderRelay,
  keptRunningProviderRelayPid
} from '../../provider-relay/provider-relay-launch-inventory'
import { daemonReadsFolder } from '../../provider-relay/provider-relay-spawn-request'

const CONNECT_TIMEOUT_MS = 1_000
const TOKEN_READ_MS = 5_000
const FRONT_REQUEST_TIMEOUT_MS = 5_000
const SERVE_RETRY_MIN_MS = 5_000
const SERVE_RETRY_MAX_MS = 60_000

/** A launch's front: its loopback origin and the daemon start holding it. */
export type ToolRelayFront = { origin: string; daemonInstance: string }

/** A chat's launch whose agent the terminal daemon will run in `cwd`, so it may outlive the app. */
export type ToolRelayKeep = { chatKey: string; cwd: string }

type Watched = {
  stop: () => void
  port: number | null
  /** The latest serve request, rejecting when it failed; announcements wait for it, so the Host
   *  check knows the port. */
  served: Promise<void>
  /** Bumped by each hello: a connection serves once, however many chats launch on it. */
  connection: number
  servedConnection: number | null
  /** Announced connections being opened, so a re-announcement starts no second one. */
  opening: Set<string>
  /** This connection's read of the daemon's token, shared by every connection it opens. */
  token: Promise<string> | null
  /** Relay ends heard while a serve is asked: its reply may still list them. */
  ended: Set<string> | null
  /** The wait before a failed serve is asked again, and that retry while it waits. */
  retryMs: number
  retry: ReturnType<typeof setTimeout> | null
  /** When a held call last asked for a serve, so calls ask at most once per retry wait. */
  askedAt: number
}

export class ToolRelayFronts {
  private readonly watched = new Map<DaemonClient, Watched>()
  private closed = false
  /** Cancels connection setup still running when this closes. */
  private readonly closing = new AbortController()

  constructor(
    /** Takes a front's connection, with the port of the front it came through. */
    private readonly accept: (socket: Socket, port: number | null) => void,
    /** The grants a daemon start holds for the agents it keeps, from each serve's reply. */
    private readonly adopt: (
      client: DaemonClient,
      kept: readonly ToolRelayFrontKeptRelay[]
    ) => void,
    /** A kept agent's relay ended on that start, so its grants went there. */
    private readonly keptEnded: (client: DaemonClient, relayId: string) => void
  ) {}

  /**
   * The front of the daemon start the chat's agent runs on: the one its kept agent runs under, or
   * the one new agents go to. Null where there is none (an older daemon, Windows, a remote host),
   * or where that start couldn't keep the agent, so the launch wouldn't run under it.
   */
  async current({ chatKey, cwd }: ToolRelayKeep): Promise<ToolRelayFront | null> {
    const route = providerRelayRoute()
    if (!route || this.closed) {
      return null
    }
    // A kept agent still running is reattached under its start; any other launch spawns on the current one.
    const kept = keptRunningProviderRelayPid(chatKey) === null ? null : keptProviderRelay(chatKey)
    const client = kept ? kept.channel.client : await route.current().catch(() => null)
    if (!client || !(await connected(client))) {
      return null
    }
    const identity = client.getDaemonIdentity()
    const keeps = identity?.toolRelayFront && identity.providerRelay && identity.providerRelayKeep
    if (!keeps || (!kept && !(await daemonReadsFolder(client, cwd)))) {
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

  /** The serve of the daemon start whose front is `port`: its kept agents' tokens are known once it settles. */
  servedAt(port: number): Promise<void> | null {
    for (const watched of this.watched.values()) {
      if (watched.port === port) {
        return watched.served
      }
    }
    return null
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
    this.closing.abort()
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
      const payload = jsonProperty(event, 'payload')
      const id = jsonProperty(payload, 'frontConnectionId')
      const ended = jsonProperty(payload, 'keptEnded')
      if (typeof id === 'string') {
        void this.answer(client, id)
      } else if (typeof ended === 'string') {
        // Ends come on the stream and the serve reply on control, in either order.
        this.watched.get(client)?.ended?.add(ended)
        this.keptEnded(client, ended)
      }
    })
    // Each hello (a reconnect, or a new daemon start under the same client) serves again.
    const stopConnected = client.connectedListeners.add(() => {
      const watched = this.watched.get(client)
      if (watched) {
        watched.connection += 1
        watched.token = null
        // The last connection's retry is moot; this one's failure schedules its own.
        clearTimeout(watched.retry ?? undefined)
        watched.retry = null
        watched.retryMs = SERVE_RETRY_MIN_MS
      }
      void this.serveOnce(client).catch(() => {})
    })
    this.watched.set(client, {
      port: null,
      served: Promise.resolve(),
      connection: 0,
      servedConnection: null,
      opening: new Set(),
      token: null,
      ended: null,
      askedAt: 0,
      retryMs: SERVE_RETRY_MIN_MS,
      retry: null,
      stop: () => {
        stopEvents()
        stopConnected()
        const retry = this.watched.get(client)?.retry
        clearTimeout(retry ?? undefined)
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
      // A launch sharing a serve that failed fails too: it gets no front nobody serves.
      return watched.served
    }
    watched.servedConnection = watched.connection
    const ended = new Set<string>()
    watched.ended = ended
    const served = client
      .request<ToolRelayFrontServeResult>(
        'toolRelayFrontServe',
        undefined,
        FRONT_REQUEST_TIMEOUT_MS
      )
      .then(({ port, kept }) => {
        this.noteServed(client, Number.isSafeInteger(port) ? port : null)
        // Before any held connection is answered, so a kept agent's token is already known.
        const live = (Array.isArray(kept) ? kept : []).filter((relay) => !ended.has(relay.relayId))
        this.adopt(client, live)
      })
      .finally(() => {
        if (watched.ended === ended) {
          watched.ended = null
        }
      })
    watched.served = served
    served.then(
      () => {
        watched.retryMs = SERVE_RETRY_MIN_MS
        clearTimeout(watched.retry ?? undefined)
        watched.retry = null
      },
      () => {
        // A failed serve is asked again by the next launch or hello, and meanwhile a few times on
        // its own (backing off), so agents kept under an older daemon start needn't wait for one.
        if (watched.servedConnection !== watched.connection) {
          return
        }
        watched.servedConnection = null
        // One retry waits per daemon start, however many launches failed meanwhile.
        if (watched.retry || watched.retryMs > SERVE_RETRY_MAX_MS) {
          return
        }
        const connection = watched.connection
        watched.retry = setTimeout(() => {
          watched.retry = null
          // A daemon start that's gone stops here; its next hello serves again.
          if (
            this.watched.get(client) === watched &&
            watched.connection === connection &&
            client.isConnected()
          ) {
            void this.serveOnce(client).catch(() => {})
          }
        }, watched.retryMs)
        watched.retry.unref()
        watched.retryMs *= 2
      }
    )
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
    // The daemon holds at most that many, so more would be setups for connections it already let go.
    const full = watched && watched.opening.size >= TOOL_RELAY_FRONT_MAX_HELD
    if (this.closed || !watched || full || watched.opening.has(frontConnectionId)) {
      return
    }
    watched.opening.add(frontConnectionId)
    try {
      // The daemon re-announces held connections while it answers the serve request. Unserved,
      // its kept agents' tokens aren't known: the connection stays held and gets the 503.
      if (!(await watched.served.then(() => true).catch(() => false))) {
        // The call itself asks for a serve (one at a time), so its retry finds the front served.
        if (Date.now() - watched.askedAt >= SERVE_RETRY_MIN_MS) {
          watched.askedAt = Date.now()
          void this.serveOnce(client).catch(() => {})
        }
        return
      }
      // One retry: the daemon announces a held connection once per serving connection.
      for (let attempt = 0; attempt < 2 && !this.closed; attempt += 1) {
        const opened = await openDaemonToolRelayConnection(
          client,
          frontConnectionId,
          this.closing.signal,
          () => this.token(client, watched)
        ).catch(() => null)
        if (!opened) {
          continue
        }
        // Closed meanwhile: a late connection is never served.
        if (this.closed) {
          opened.socket.destroy()
          return
        }
        if (opened.remainder.length > 0) {
          opened.socket.unshift(opened.remainder)
        }
        this.accept(opened.socket, watched.port)
        return
      }
      // Unopened, the daemon answers the held connection itself once its hold runs out.
    } finally {
      watched.opening.delete(frontConnectionId)
    }
  }

  /** Read once per connection, bounded, and dropped when it fails so the next one reads again. */
  private token(client: DaemonClient, watched: Watched): Promise<string> {
    if (watched.token) {
      return watched.token
    }
    const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(TOKEN_READ_MS)])
    const read = readFile(client.tokenPath, { encoding: 'utf8', signal }).then((token) =>
      token.trim()
    )
    watched.token = read
    read.catch(() => {
      if (watched.token === read) {
        watched.token = null
      }
    })
    return read
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
