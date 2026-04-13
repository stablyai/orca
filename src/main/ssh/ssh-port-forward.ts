import { createServer, type Server, type Socket } from 'net'
import type { SshConnection } from './ssh-connection'

export type PortForwardEntry = {
  id: string
  connectionId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

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
    const id = `pf-${this.nextId++}`
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

  removeForward(id: string): boolean {
    const forward = this.forwards.get(id)
    if (!forward) {
      return false
    }

    for (const socket of forward.activeSockets) {
      socket.destroy()
    }
    forward.server.close()
    this.forwards.delete(id)
    return true
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

  removeAllForwards(connectionId: string): void {
    // Why: removeForward deletes from this.forwards. Collecting IDs first
    // avoids mutating the map during iteration, which is fragile if
    // removeForward ever gains cascading cleanup.
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => entry.connectionId === connectionId)
      .map(([id]) => id)
    for (const id of toRemove) {
      this.removeForward(id)
    }
  }

  dispose(): void {
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
