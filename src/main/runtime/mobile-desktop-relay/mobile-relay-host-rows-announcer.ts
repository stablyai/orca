import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from '../client/events/keyed-trailing-edge-coalescer'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from './mobile-desktop-relay-hosts'
import {
  describeRelayHosts,
  relayHostFence,
  type DescribedRelayHost
} from './mobile-relay-host-descriptions'

// The server's own worktreeRowsChanged windows, so a busy agent costs the phone no more than one here would.
const ROWS_FLUSH_MS = 500
const ROWS_MAX_WAIT_MS = 2000

/** The phone connection reading a server's rows, and where its release runs when it closes. */
export type RelayPhoneReader = {
  connectionId: string
  onClose: (release: () => void) => void
}

export type RelayHostRowsSources = Pick<
  MobileDesktopRelayHosts,
  'watchChanges' | 'onStatusChanged'
> & {
  /** The servers as the desktop describes them now. */
  describe: () => Promise<DescribedRelayHost[]>
}

export function relayHostRowsSources(hosts: MobileDesktopRelayHosts): RelayHostRowsSources {
  return {
    watchChanges: (host, expected, callbacks) => hosts.watchChanges(host, expected, callbacks),
    onStatusChanged: (listener) => hosts.onStatusChanged(listener),
    describe: () => describeRelayHosts(hosts)
  }
}

type OpenWatch = {
  watch: MobileDesktopRelayHostWatch | null
  closed: boolean
  ready: boolean
  // Changes may have gone unheard before the stream's ready, so its ready is announced.
  announceReady: boolean
}

type WatchedServer = {
  host: DescribedRelayHost
  connections: Set<string>
  // Null while the server's stream is down: the holds stay, and the watch reopens when it is back.
  open: OpenWatch | null
  // Spent once per hold, so a stream that readies then drops can't loop read, reopen, announce.
  earlyReadAnnounced: boolean
}

/**
 * Calls `changed` when a relayed server's agent rows change, so phones need not poll them. A server
 * is watched only while a phone connection that read its rows stays open.
 */
export class RelayHostRowsAnnouncer {
  private readonly servers = new Map<string, WatchedServer>()
  private readonly coalescer: KeyedTrailingEdgeCoalescer
  private stopStatusWatch: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly sources: RelayHostRowsSources,
    changed: (hostId: `runtime:${string}`) => void
  ) {
    this.coalescer = createKeyedTrailingEdgeCoalescer(
      (environmentId) => changed(toRuntimeExecutionHostId(environmentId)),
      { flushMs: ROWS_FLUSH_MS, maxWaitMs: ROWS_MAX_WAIT_MS }
    )
  }

  /** A phone connection read this server's rows: watch the server until the last such connection closes. */
  hold(host: DescribedRelayHost, reader: RelayPhoneReader | undefined): void {
    // A server that publishes no row notices gives the watch nothing to hear; phones back it up themselves.
    if (!reader || this.disposed || host.rowChanges !== true) {
      return
    }
    const key = host.environmentId
    let server = this.servers.get(key)
    if (!server) {
      server = { host, connections: new Set(), open: null, earlyReadAnnounced: false }
      this.servers.set(key, server)
      this.stopStatusWatch ??= this.sources.onStatusChanged((contact) =>
        this.reopenReturned(contact)
      )
    }
    // A re-pair moves every phone's hold to the new watch.
    const fence = relayHostFence(host.identity)
    if (!this.watching(server) || relayHostFence(server.host.identity) !== fence) {
      this.open(server, host, false)
    }
    if (server.connections.has(reader.connectionId)) {
      return
    }
    server.connections.add(reader.connectionId)
    const held = server
    reader.onClose(() => {
      held.connections.delete(reader.connectionId)
      if (held.connections.size === 0 && this.servers.get(key) === held) {
        this.stop(key, held)
      }
    })
  }

  /** The phone's read fetched this server's rows: one that landed before the stream was ready may miss a change. */
  refreshed(environmentId: string): void {
    const server = this.servers.get(environmentId)
    if (server?.open && !server.open.ready && !server.earlyReadAnnounced) {
      server.earlyReadAnnounced = true
      server.open.announceReady = true
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [key, server] of this.servers) {
      this.stop(key, server)
    }
    this.coalescer.dispose()
  }

  private watching(server: WatchedServer): boolean {
    return server.open !== null && server.open.watch?.current() !== false
  }

  /** A held server whose stream ended is back: watch it again, and tell phones once its stream is ready. */
  private reopenReturned(contact?: { environmentId: string; inContact: boolean }): void {
    const dropped = [...this.servers].filter(
      ([key, server]) =>
        !this.watching(server) && (!contact || (contact.environmentId === key && contact.inContact))
    )
    if (dropped.length === 0) {
      return
    }
    void this.sources.describe().then(
      (described) => {
        for (const [key, server] of dropped) {
          const host = described.find((entry) => entry.environmentId === key)
          if (host?.health === 'available' && this.servers.get(key) === server) {
            if (!this.watching(server)) {
              this.open(server, host, true)
            }
          }
        }
      },
      () => {}
    )
  }

  private open(server: WatchedServer, host: DescribedRelayHost, announceReady: boolean): void {
    this.closeWatch(server)
    server.host = host
    const open: OpenWatch = { watch: null, closed: false, ready: false, announceReady }
    server.open = open
    const key = host.environmentId
    const changed = (): void => {
      if (!open.closed) {
        this.coalescer.schedule(key)
      }
    }
    const drop = (): void => {
      if (server.open === open) {
        this.closeWatch(server)
      }
    }
    void Promise.resolve(
      this.sources.watchChanges(host, host.identity, {
        // The opening ready alone is no change, or a flapping stream would loop read, open, ready.
        onChange: () => {
          if (open.ready || open.announceReady) {
            changed()
          }
          open.ready = true
          open.announceReady = false
        },
        onRowsChanged: changed,
        onClose: drop
      })
    ).then((watch) => {
      if (open.closed) {
        watch.close()
      } else {
        open.watch = watch
      }
    }, drop)
  }

  private closeWatch(server: WatchedServer): void {
    const open = server.open
    server.open = null
    if (open) {
      open.closed = true
      open.watch?.close()
    }
  }

  private stop(key: string, server: WatchedServer): void {
    this.closeWatch(server)
    this.servers.delete(key)
    this.coalescer.cancel(key)
    if (this.servers.size === 0) {
      this.stopStatusWatch?.()
      this.stopStatusWatch = null
    }
  }
}
