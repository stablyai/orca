import type { Server } from 'node:http'

/** Binds the relay hook server on loopback only — reachable by the in-box agent CLI (127.0.0.1),
 *  not from outside the box. Resolves the bound port when the address reports one. */
export function listenOnLoopback(server: Server, port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const onStartupError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onStartupError)
      server.on('error', (err) => {
        process.stderr.write(`[relay-hook-server] server error: ${err.message}\n`)
      })
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : undefined)
    }
    server.once('error', onStartupError)
    server.listen(port, '127.0.0.1', onListening)
  })
}
