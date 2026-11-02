import { connect } from 'node:net'

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', ''])
const PROBE_TIMEOUT_MS = 1_000

/** Windows/macOS permit loopback binds over existing wildcard listeners, redirecting paired clients; report EADDRINUSE so the port ladder moves on.
 * Probe by loopback connect: trial wildcard listening raises Windows Firewall prompts. Linux already refuses overlapping binds. */
export async function assertPortNotShadowingListener(host: string, port: number): Promise<void> {
  if (port === 0 || WILDCARD_HOSTS.has(host)) {
    return
  }
  const answered = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const settle = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
  if (answered) {
    throw Object.assign(new Error(`listen EADDRINUSE: ${host}:${port} already answers`), {
      code: 'EADDRINUSE',
      syscall: 'listen',
      port
    })
  }
}
