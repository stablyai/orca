import type { SshConnection } from '../connection/ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import type { PortForwardEntry } from '../../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

// Bound waiting for slow starts; their closed flag cleans up late results. Wait for closes because rebind needs the port.
const TEARDOWN_START_WAIT_MS = 3_000

/** Overtaken starts hold nothing; do not roll back an edit after connection teardown. */
export class PortForwardTornDownError extends Error {
  constructor() {
    super('The SSH session closed while this port forward was starting.')
    this.name = 'PortForwardTornDownError'
  }
}

/** Track pending starts/closes until settled because either may still hold its port. */
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
    // Reject connections selected before teardown so late adds/edits cannot outlive disposal.
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
      // Check during registration so teardown cannot miss this forward.
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

    // Await OS port release before same-port edits or rebind can fail EADDRINUSE.
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
      // Rollback with the original id so renderer references stay valid.
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
      } catch {}
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

  // Rebind callers must await async listener close or process exit.
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

  async closeStaleForwards(connectionId: string, conn: SshConnection): Promise<void> {
    const stale = [...this.forwards.entries()]
      .filter(([, forward]) => forward.entry.connectionId === connectionId)
      .filter(([, forward]) => forward.isLive?.(conn) === false)
      .map(([id]) => id)
    await Promise.all(stale.map((id) => this.removeForwardAsync(id)))
  }

  async closeAll(): Promise<void> {
    await this.closeAndSettle()
  }

  /** Wait for all owned starts/closes, including those underway before teardown, to release their ports. */
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
