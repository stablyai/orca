import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from '../client/events/keyed-trailing-edge-coalescer'
import type { DescribedRelayHost } from './mobile-relay-host-descriptions'

// The server's own worktreeRowsChanged windows, so a busy agent costs the phone no more than one here would.
const ROWS_FLUSH_MS = 500
const ROWS_MAX_WAIT_MS = 2000

/** The phone connection reading a server's rows, and where its release runs when it closes. */
export type RelayHostRowsReader = {
  connectionId: string
  onClose: (release: () => void) => void
}

/** Agent-row change notices by server, from the watch the desktop already keeps on each paired server. */
export type RelayHostAgentRowsChanges = {
  onChange: (listener: (environmentId: string) => void) => () => void
}

/**
 * Calls `changed` when a relayed server's agent rows change, so phones need not poll them. Only
 * servers a still-open phone connection has read are announced.
 */
export class RelayHostRowsAnnouncer {
  private readonly readers = new Map<string, Set<string>>()
  private readonly coalescer: KeyedTrailingEdgeCoalescer
  private readonly stopListening: () => void

  constructor(source: RelayHostAgentRowsChanges, changed: (hostId: `runtime:${string}`) => void) {
    this.coalescer = createKeyedTrailingEdgeCoalescer(
      (environmentId) => changed(toRuntimeExecutionHostId(environmentId)),
      { flushMs: ROWS_FLUSH_MS, maxWaitMs: ROWS_MAX_WAIT_MS }
    )
    this.stopListening = source.onChange((environmentId) => {
      if (this.readers.has(environmentId)) {
        this.coalescer.schedule(environmentId)
      }
    })
  }

  /** A phone connection read this server's rows: announce the server until the last such connection closes. */
  hold(host: DescribedRelayHost, reader: RelayHostRowsReader | undefined): void {
    const key = host.environmentId
    const connections = this.readers.get(key) ?? new Set<string>()
    if (!reader || connections.has(reader.connectionId)) {
      return
    }
    connections.add(reader.connectionId)
    this.readers.set(key, connections)
    reader.onClose(() => {
      connections.delete(reader.connectionId)
      if (connections.size === 0 && this.readers.get(key) === connections) {
        this.readers.delete(key)
        this.coalescer.cancel(key)
      }
    })
  }

  dispose(): void {
    this.stopListening()
    this.readers.clear()
    this.coalescer.dispose()
  }
}
