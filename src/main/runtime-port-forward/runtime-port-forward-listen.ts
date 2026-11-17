import { createServer, type Server, type Socket } from 'node:net'

export type ListenOutcome = { ok: true; servers: Server[] } | { ok: false; busy: boolean }

function listenOnce(
  server: Server,
  port: number,
  host: string
): Promise<'ok' | 'busy' | 'unavailable'> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'busy' : 'unavailable')
    }
    server.once('error', onError)
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', onError)
      resolve('ok')
    })
  })
}

/** Binds both loopback families so `localhost` reaches the forward whichever one the browser picks. */
export async function listenLoopback(
  port: number,
  accept: (socket: Socket) => void
): Promise<ListenOutcome & { port?: number }> {
  const v4 = createServer({ allowHalfOpen: true }, accept)
  const v4Result = await listenOnce(v4, port, '127.0.0.1')
  if (v4Result !== 'ok') {
    v4.close()
    return { ok: false, busy: v4Result === 'busy' }
  }
  const address = v4.address()
  const boundPort = address && typeof address === 'object' ? address.port : port
  const v6 = createServer({ allowHalfOpen: true }, accept)
  const v6Result = await listenOnce(v6, boundPort, '::1')
  if (v6Result === 'busy') {
    // Another local process owns [::1]:port; browsers resolving localhost to ::1 would reach it instead.
    v4.close()
    v6.close()
    return { ok: false, busy: true }
  }
  if (v6Result !== 'ok') {
    v6.close()
    return { ok: true, servers: [v4], port: boundPort }
  }
  return { ok: true, servers: [v4, v6], port: boundPort }
}
