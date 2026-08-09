import { createServer } from 'node:net'

/** Allocates an OS-assigned free TCP port on 127.0.0.1 by binding then immediately releasing it. */
export function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a free local port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
