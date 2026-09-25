import { rmSync } from 'node:fs'
import type { Server, Socket } from 'node:net'
import type { WebSocketServer } from 'ws'

export async function cleanupBrowserRouteTcpEgressFixture(
  root: string,
  servers: (Server | null)[],
  webSocket: WebSocketServer,
  sockets: Set<Socket>
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const client of webSocket.clients) {
    client.terminate()
  }
  try {
    await closeWithTimeout(
      new Promise<void>((resolve, reject) =>
        webSocket.close((error) => (error ? reject(error) : resolve()))
      ),
      'browser_route_tcp_probe_websocket_close_timeout'
    )
  } catch (error) {
    failures.push(error)
  }
  for (const socket of sockets) {
    socket.destroy()
  }
  for (const server of servers) {
    if (!server?.listening) {
      continue
    }
    try {
      await closeWithTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
        'browser_route_tcp_probe_server_close_timeout'
      )
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    failures.push(error)
  }
  return failures
}

function closeWithTimeout(operation: Promise<void>, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 5000)
    operation.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}
