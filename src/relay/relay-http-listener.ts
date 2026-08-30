import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

export function listenRelayHttpServer(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      server.close()
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      server.on('error', (error) =>
        process.stderr.write(`[relay-hook-server] server error: ${error.message}\n`)
      )
      const address = server.address()
      resolve({ server, port: address && typeof address === 'object' ? address.port : 0 })
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', onListening)
  })
}
