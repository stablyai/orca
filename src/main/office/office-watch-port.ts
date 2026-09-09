/**
 * Picking a port for a watch server, and knowing when it is answering.
 *
 * `officecli watch` binds `127.0.0.1` only and takes the port as an argument, so Orca has to
 * choose one. Asking the OS for an ephemeral port and releasing it leaves a window in which
 * something else can take it — the race is real, so the caller retries rather than pretending
 * the allocation was atomic.
 */
import { createServer, connect, type Socket } from 'node:net'

/** Bind `127.0.0.1:0`, read the assigned port, release it. Loopback only: never a routable bind. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a loopback port')))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })
}

function tryConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveConnected) => {
    let socket: Socket | null = null
    const settle = (answered: boolean): void => {
      socket?.destroy()
      socket = null
      resolveConnected(answered)
    }
    socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

export type WatchReadinessProbe = {
  intervalMs: number
  timeoutMs: number
  /** Answers false once the child is gone, so a crashed spawn fails immediately, not at the ceiling. */
  isAlive?: () => boolean
}

export type WatchReadiness = 'ready' | 'timeout' | 'exited'

/**
 * Poll until the port accepts a connection.
 *
 * A child that exits during the poll ends it as `exited`, which the caller reports as a watch
 * failure with the child's own output — a 15 s wait for a process that died in the first 200 ms
 * tells the reader nothing and delays the fallback to the snapshot.
 */
export async function waitForWatchPort(
  port: number,
  probe: WatchReadinessProbe,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<WatchReadiness> {
  const deadline = Date.now() + probe.timeoutMs
  for (;;) {
    if (await tryConnect(port, probe.intervalMs * 4)) {
      return 'ready'
    }
    if (probe.isAlive && !probe.isAlive()) {
      return 'exited'
    }
    if (Date.now() >= deadline) {
      return 'timeout'
    }
    await sleep(probe.intervalMs)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms).unref?.()
  })
}
