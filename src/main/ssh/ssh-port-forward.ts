import { createServer, type Server, type Socket } from 'net'
import type { SshConnection } from './ssh-connection'
import type { PortForwardEntry } from '../../shared/ssh-types'

export type { PortForwardEntry }

type ActiveForward = {
  entry: PortForwardEntry
  server: Server
  activeSockets: Set<Socket>
}

export class SshPortForwardManager {
  private forwards = new Map<string, ActiveForward>()
  private nextId = 1

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
    const entry: PortForwardEntry = {
      id,
      connectionId,
      localPort,
      remoteHost,
      remotePort,
      label
    }

    const client = conn.getClient()
    if (!client) {
      throw new Error('SSH connection is not established')
    }

    const activeSockets = new Set<Socket>()

    const server = createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))

      client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, channel) => {
        if (err) {
          socket.destroy()
          return
        }
        socket.pipe(channel).pipe(socket)
        channel.on('close', () => socket.destroy())
        socket.on('close', () => channel.close())
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject)
      server.listen(localPort, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    this.forwards.set(id, { entry, server, activeSockets })
    return entry
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
      return await this.addForward(
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
    this.teardownForward(forward)
    this.forwards.delete(id)
    return forward.entry
  }

  // Why: server.close() is async — the OS may not release the port until the
  // callback fires. callers that need to rebind the same port (updateForward)
  // must await this variant.
  private removeForwardAsync(id: string): Promise<PortForwardEntry | null> {
    const forward = this.forwards.get(id)
    if (!forward) {
      return Promise.resolve(null)
    }
    for (const socket of forward.activeSockets) {
      socket.destroy()
    }
    this.forwards.delete(id)
    return new Promise((resolve) => {
      forward.server.close(() => resolve(forward.entry))
    })
  }

  private teardownForward(forward: ActiveForward): void {
    for (const socket of forward.activeSockets) {
      socket.destroy()
    }
    forward.server.close()
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
    // Why: await each removal so the OS fully releases ports before callers
    // (like restorePortForwards) try to rebind on the same local ports.
    await Promise.all(toRemove.map((id) => this.removeForwardAsync(id)))
  }

  dispose(): void {
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
