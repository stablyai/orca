import { connect } from 'node:net'

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', ''])
const PROBE_TIMEOUT_MS = 1_000

/**
 * Windows and macOS let a specific-address bind (127.0.0.1:6768) succeed while another process
 * holds the wildcard (0.0.0.0:6768); loopback clients then reach the newcomer instead of the
 * runtime they paired with. A port something already answers on is reported as EADDRINUSE so the
 * port ladder moves on, as it does on Linux where the kernel refuses that overlap itself.
 *
 * Why a connect rather than a trial wildcard bind: listening on 0.0.0.0 raises a Windows Firewall
 * prompt on the user's desktop; a loopback connect does not.
 */
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
