import type { SshConnection } from './ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import type { PortForwardEntry } from '../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

export type { PortForwardEntry }
export type { PortForwardCloseReason }

type SshPortForwardManagerCallbacks = {
  onForwardClosed?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export class SshPortForwardManager {
  private forwards = new Map<string, StartedPortForward>()
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
    const provider = this.providers.find((candidate) => candidate.canHandle(conn))
    if (!provider) {
      throw new Error('SSH connection is not established')
    }

    let forward: StartedPortForward | null = null
    forward = await provider.start(conn, {
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
    this.forwards.set(id, forward)
    return forward.entry
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
    return forward.close().then(() => forward.entry)
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
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => entry.connectionId === connectionId)
      .map(([id]) => id)
    await Promise.all(toRemove.map((id) => this.removeForwardAsync(id)))
  }

  dispose(): void {
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
