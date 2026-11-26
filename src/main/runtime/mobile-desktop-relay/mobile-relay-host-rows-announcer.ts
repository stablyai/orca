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
export type RelayHostRowsReader = {
  connectionId: string
  onClose: (release: () => void) => void
}

export type RelayHostRowsSources = Pick<
  MobileDesktopRelayHosts,
  'watchChanges' | 'onStatusChanged'
> & {
  /** The server as the desktop describes it now; undefined once it is no longer relayed. */
  describe: (environmentId: string) => Promise<DescribedRelayHost | undefined>
}

export function relayHostRowsSources(hosts: MobileDesktopRelayHosts): RelayHostRowsSources {
  return {
    watchChanges: (host, expected, callbacks) => hosts.watchChanges(host, expected, callbacks),
    onStatusChanged: (listener) => hosts.onStatusChanged(listener),
    describe: async (environmentId) =>
      (await describeRelayHosts(hosts)).find((host) => host.environmentId === environmentId)
  }
}

type OpenWatch = { watch: MobileDesktopRelayHostWatch | null; closed: boolean }

type WatchedServer = {
  host: DescribedRelayHost
  connections: Set<string>
  // Null while the server's stream is down: the holds stay, and the watch reopens when it is back.
  open: OpenWatch | null
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
  hold(host: DescribedRelayHost, reader: RelayHostRowsReader | undefined): void {
    if (!reader || this.disposed) {
      return
    }
    const key = host.environmentId
    let server = this.servers.get(key)
    if (!server) {
      server = { host, connections: new Set(), open: null }
      this.servers.set(key, server)
      this.stopStatusWatch ??= this.sources.onStatusChanged((contact) =>
        this.reopenReturned(contact)
      )
    }
    // A re-pair moves every phone's hold to the new watch.
    if (
      !this.watching(server) ||
      relayHostFence(server.host.identity) !== relayHostFence(host.identity)
    ) {
      this.open(server, host)
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

  /** A held server whose stream ended is back: watch it again and tell phones, since changes went unheard. */
  private reopenReturned(contact?: { environmentId: string; inContact: boolean }): void {
    for (const [key, server] of this.servers) {
      if (
        this.watching(server) ||
        (contact && (contact.environmentId !== key || !contact.inContact))
      ) {
        continue
      }
      void this.sources.describe(key).then(
        (host) => {
          if (
            host?.health === 'available' &&
            this.servers.get(key) === server &&
            !this.watching(server)
          ) {
            this.open(server, host)
            this.coalescer.schedule(key)
          }
        },
        () => {}
      )
    }
  }

  private open(server: WatchedServer, host: DescribedRelayHost): void {
    this.closeWatch(server)
    server.host = host
    const open: OpenWatch = { watch: null, closed: false }
    server.open = open
    const key = host.environmentId
    const changed = (): void => {
      if (!open.closed) {
        this.coalescer.schedule(key)
      }
    }
    // The stream's opening ready is no change; announcing it would loop read, open, ready on a flapping stream.
    let opened = false
    const drop = (): void => {
      if (server.open === open) {
        this.closeWatch(server)
      }
    }
    void Promise.resolve(
      this.sources.watchChanges(host, host.identity, {
        // A reconnect replay or a workspace change may stand for missed row changes.
        onChange: () => {
          if (opened) {
            changed()
          }
          opened = true
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
