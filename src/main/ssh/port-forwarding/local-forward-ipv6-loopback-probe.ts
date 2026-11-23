import { connect } from 'node:net'

// Loopback answers at once on POSIX; Windows retries a refused SYN for seconds, which also means nothing listens.
const IPV6_LOOPBACK_PROBE_TIMEOUT_MS = 150

/** Forwards listen on 127.0.0.1 only; a browser tries [::1] first for localhost, so a server there would answer instead. */
export async function assertIpv6LoopbackPortFree(localPort: number): Promise<void> {
  if (await ipv6LoopbackAccepts(localPort)) {
    throw new Error(
      `Local port ${localPort} is already in use on [::1] by another server, which would answer localhost:${localPort}`,
      { cause: 'EADDRINUSE' }
    )
  }
}

// A connect probe, not a bind: macOS lets 127.0.0.1 and ::1 bind beside a server listening on [::].
function ipv6LoopbackAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '::1', port })
    const finish = (accepted: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(accepted)
    }
    const timer = setTimeout(() => finish(false), IPV6_LOOPBACK_PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    // No IPv6 loopback, or nothing listening.
    socket.once('error', () => finish(false))
  })
}
