import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from '../client/events/keyed-trailing-edge-coalescer'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from './mobile-desktop-relay-hosts'
import { relayHostFence, type DescribedRelayHost } from './mobile-relay-host-descriptions'

// The server's own worktreeRowsChanged windows, so a busy agent costs the phone no more than one here would.
const ROWS_FLUSH_MS = 500
const ROWS_MAX_WAIT_MS = 2000

/** The phone connection reading a server's rows, and where its release runs when it closes. */
export type RelayHostRowsReader = {
  connectionId: string
  onClose: (release: () => void) => void
}

type WatchedServer = {
  fence: string
  connections: Set<string>
  watch: MobileDesktopRelayHostWatch | null
  stopped: boolean
}

/**
 * Calls `changed` when a relayed server's agent rows change, so phones need not poll them. A server
 * is watched only while a phone connection that read its rows stays open.
 */
export class RelayHostRowsAnnouncer {
  private readonly servers = new Map<string, WatchedServer>()
  private readonly coalescer: KeyedTrailingEdgeCoalescer
  private disposed = false

  constructor(
    private readonly hosts: Pick<MobileDesktopRelayHosts, 'watchChanges'>,
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
    if (!server || server.fence !== relayHostFence(host.identity)) {
      if (server) {
        this.stop(key, server)
      }
      server = this.open(host)
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

  private open(host: DescribedRelayHost): WatchedServer {
    const key = host.environmentId
    const server: WatchedServer = {
      fence: relayHostFence(host.identity),
      connections: new Set(),
      watch: null,
      stopped: false
    }
    this.servers.set(key, server)
    // A stream that ends drops the watch; the phone's next read, on relayHostsChanged or focus, opens it again.
    const drop = (): void => {
      if (this.servers.get(key) === server) {
        this.stop(key, server)
      }
    }
    const changed = (): void => {
      if (!server.stopped) {
        this.coalescer.schedule(key)
      }
    }
    void Promise.resolve(
      this.hosts.watchChanges(host, host.identity, {
        // A reconnect replay or a workspace change may stand for missed row changes.
        onChange: changed,
        onRowsChanged: changed,
        onClose: drop
      })
    ).then((watch) => {
      if (server.stopped) {
        watch.close()
      } else {
        server.watch = watch
      }
    }, drop)
    return server
  }

  private stop(key: string, server: WatchedServer): void {
    server.stopped = true
    server.watch?.close()
    this.servers.delete(key)
    this.coalescer.cancel(key)
  }
}
