import type { SshConnection } from '../connection/ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import type { PortForwardEntry } from '../../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

// Why bounded: a start on an unresponsive host can take long, and its `closed` flag already ends
// it when it resolves; only a close needs waiting out, since a rebind needs its port.
const TEARDOWN_START_WAIT_MS = 3_000

/** A start the connection's teardown overtook; it holds nothing, so an edit must not roll back. */
export class PortForwardTornDownError extends Error {
  constructor() {
    super('The SSH session closed while this port forward was starting.')
    this.name = 'PortForwardTornDownError'
  }
}

/**
 * A forward between states: starting (closed as soon as it resolves once `closed` is set) or
 * closing. Either may still hold its port, so a teardown waits for `settled`.
 */
type ForwardInTransit = {
  kind: 'starting' | 'closing'
  connectionId: string
  closed: boolean
  settled: Promise<unknown>
}

type SshPortForwardManagerCallbacks = {
  onForwardClosed?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export class SshPortForwardManager {
  private forwards = new Map<string, StartedPortForward>()
  private inTransit = new Set<ForwardInTransit>()
  private nextId = 1
  private providers: SshPortForwardProvider[]
  private callbacks: SshPortForwardManagerCallbacks

  constructor(
    callbacks: SshPortForwardManagerCallbacks = {},
    providers: SshPortForwardProvider[] = [
      new Ssh2PortForwardProvider(),
      new SystemSshPortForwardProvider()
    ]
  ) {
    this.callbacks = callbacks
    this.providers = providers
  }

  setCallbacks(callbacks: SshPortForwardManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async addForward(
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    return this.addForwardWithId(
      `pf-${this.nextId++}`,
      connectionId,
      conn,
      localPort,
      remoteHost,
      remotePort,
      label
    )
  }

  private async addForwardWithId(
    id: string,
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    // Why: a teardown disposes its connection at once, so an add or edit that reaches here later
    // (its connection picked before the teardown) must not open a forward that outlives it.
    if (conn.isDisposed()) {
      throw new PortForwardTornDownError()
    }
    const provider = this.providers.find((candidate) => candidate.canHandle(conn))
    if (!provider) {
      throw new Error('SSH connection is not established')
    }

    let forward: StartedPortForward | null = null
    const starting: ForwardInTransit = {
      kind: 'starting',
      connectionId,
      closed: false,
      settled: Promise.resolve()
    }
    const settled = (async (): Promise<StartedPortForward> => {
      const started = await provider.start(conn, {
        id,
        connectionId,
        localHost: '127.0.0.1',
        localPort,
        remoteHost,
        remotePort,
        label,
        onUnexpectedClose: (entry, reason) => {
          const active = this.forwards.get(id)
          if (active !== forward) {
            return
          }
          this.forwards.delete(id)
          this.callbacks.onForwardClosed?.(entry, reason)
        }
      })
      // Why checked with the registration: a teardown between the two would miss this forward.
      if (starting.closed || conn.isDisposed()) {
        await started.close()
        throw new PortForwardTornDownError()
      }
      forward = started
      this.forwards.set(id, started)
      return started
    })()
    starting.settled = settled
    this.inTransit.add(starting)
    try {
      return (await settled).entry
    } finally {
      this.inTransit.delete(starting)
    }
  }

  async updateForward(
    id: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const existing = this.forwards.get(id)
    if (!existing) {
      throw new Error(`Port forward "${id}" not found`)
    }
    const oldEntry = { ...existing.entry }

    // Why: use the async variant so the OS fully releases the port before
    // we try to rebind. Without this, same-port edits (e.g. label change)
    // fail with EADDRINUSE because server.close() is async.
    await this.removeForwardAsync(id)

    try {
      return await this.addForwardWithId(
        oldEntry.id,
        oldEntry.connectionId,
        conn,
        localPort,
        remoteHost,
        remotePort,
        label
      )
    } catch (err) {
      if (err instanceof PortForwardTornDownError) {
        throw err
      }
      // Why: use addForwardWithId to preserve the original ID so the
      // renderer's references remain valid after a failed edit.
      try {
        await this.addForwardWithId(
          oldEntry.id,
          oldEntry.connectionId,
          conn,
          oldEntry.localPort,
          oldEntry.remoteHost,
          oldEntry.remotePort,
          oldEntry.label
        )
      } catch {
        // best-effort rollback
      }
      throw err
    }
  }

  removeForward(id: string): PortForwardEntry | null {
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    forward.dispose()
    this.forwards.delete(id)
    return forward.entry
  }

  async removeForwardAndWait(id: string): Promise<PortForwardEntry | null> {
    return this.removeForwardAsync(id)
  }

  // Why: server.close()/process exit are async — callers that need to rebind
  // the same port (update/reconnect) must wait until the owner fully releases it.
  private removeForwardAsync(id: string): Promise<PortForwardEntry | null> {
    const forward = this.forwards.get(id)
    if (!forward) {
      return Promise.resolve(null)
    }
    this.forwards.delete(id)
    const closing: ForwardInTransit = {
      kind: 'closing',
      connectionId: forward.entry.connectionId,
      closed: true,
      settled: forward.close()
    }
    this.inTransit.add(closing)
    return closing.settled.finally(() => this.inTransit.delete(closing)).then(() => forward.entry)
  }

  listForwards(connectionId?: string): PortForwardEntry[] {
    const entries: PortForwardEntry[] = []
    for (const { entry } of this.forwards.values()) {
      if (!connectionId || entry.connectionId === connectionId) {
        entries.push(entry)
      }
    }
    return entries
  }

  async removeAllForwards(connectionId: string): Promise<void> {
    await this.closeAndSettle(connectionId)
  }

  /** Closes this connection's forwards that tunnel through a transport `conn` replaced. */
  async closeStaleForwards(connectionId: string, conn: SshConnection): Promise<void> {
    const stale = [...this.forwards.entries()]
      .filter(([, forward]) => forward.entry.connectionId === connectionId)
      .filter(([, forward]) => forward.isLive?.(conn) === false)
      .map(([id]) => id)
    await Promise.all(stale.map((id) => this.removeForwardAsync(id)))
  }

  /** Stops every forward and waits until each released its port; quit uses it. */
  async closeAll(): Promise<void> {
    await this.closeAndSettle()
  }

  /**
   * Closes `connectionId`'s forwards (every one when omitted) and resolves only once none of them
   * can still hold its port: starts and closes already under way included.
   */
  private async closeAndSettle(connectionId?: string): Promise<void> {
    const owned = (owner: string): boolean => connectionId === undefined || owner === connectionId
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => owned(entry.connectionId))
      .map(([id]) => id)
    const inTransit = [...this.inTransit].filter((forward) => owned(forward.connectionId))
    for (const forward of inTransit) {
      forward.closed = true
    }
    const removals = toRemove.map((id) => this.removeForwardAsync(id))
    let timer: ReturnType<typeof setTimeout> | undefined
    const startWait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TEARDOWN_START_WAIT_MS)
    })
    const settled = inTransit.map((forward) => {
      const done = forward.settled.catch(() => undefined)
      return forward.kind === 'starting' ? Promise.race([done, startWait]) : done
    })
    try {
      await Promise.all([...removals, ...settled])
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
