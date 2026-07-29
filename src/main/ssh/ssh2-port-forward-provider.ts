import { createServer, type Server, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

export class Ssh2PortForwardProvider implements SshPortForwardProvider {
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const client = conn.getClient()
    if (!client) {
      throw new Error('SSH connection is not established')
    }

    const activeSockets = new Set<Socket>()
    let closed = false

    const server = createServer((socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => socket.destroy())

      client.forwardOut(
        options.localHost,
        options.localPort,
        options.remoteHost,
        options.remotePort,
        (err, channel) => {
          if (err) {
            socket.destroy()
            return
          }
          if (closed || socket.destroyed) {
            closeChannel(channel)
            socket.destroy()
            return
          }
          socket.pipe(channel).pipe(socket)
          channel.on('close', () => socket.destroy())
          channel.on('error', () => socket.destroy())
          socket.on('close', () => channel.close())
        }
      )
    })

    await listen(server, options.localHost, options.localPort)

    const entry = {
      id: options.id,
      connectionId: options.connectionId,
      localPort: options.localPort,
      remoteHost: options.remoteHost,
      remotePort: options.remotePort,
      label: options.label
    }

    const close = (): Promise<void> => {
      if (closed) {
        return Promise.resolve()
      }
      closed = true
      for (const socket of activeSockets) {
        socket.destroy()
      }
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    }

    return {
      entry,
      close,
      dispose: () => {
        void close()
      }
    }
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(new Error(`Failed to listen on ${host}:${port}: ${err.message}`))
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeChannel(channel: ClientChannel): void {
  try {
    channel.close()
  } catch {
    /* best-effort cleanup for late ssh2 callbacks */
  }
}
