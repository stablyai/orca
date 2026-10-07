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

      // Why: a client whose SSH transport dropped throws synchronously; uncaught, that kills main.
      try {
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
      } catch {
        socket.destroy()
      }
    })

    await listenForPortForward(server, options.localHost, options.localPort)
    // Why: port 0 asks the OS for a free port, and callers must dial the one it bound.
    const address = server.address()
    const localPort = typeof address === 'object' && address ? address.port : options.localPort

    const entry = {
      id: options.id,
      connectionId: options.connectionId,
      localPort,
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

export function listenForPortForward(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(new Error(`Failed to listen on ${host}:${port}: ${err.message}`))
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      // An accept-time error (EMFILE) on a server with no listener would crash the main process.
      server.on('error', (error) => {
        console.warn(`[ssh] Port forward listener on ${host}:${port} failed: ${error.message}`)
      })
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
