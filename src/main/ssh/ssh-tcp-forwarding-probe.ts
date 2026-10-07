/**
 * Whether an SSH host lets this client open a local forward, asked each time a managed tunnel
 * starts. A host whose sshd refuses forwarding (`AllowTcpForwarding no`) is reached through the
 * stdio bridge instead (orcad-managed-tunnel-transport.ts).
 */
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'

export type TcpForwardingVerdict = 'allowed' | 'refused' | 'unverifiable'

/** RFC 4254 open-failure codes: sshd policy, versus a port with nothing listening. */
const ADMINISTRATIVELY_PROHIBITED = 1
const CONNECT_FAILED = 2
export const TCP_FORWARDING_PROBE_TIMEOUT_MS = 10_000

function closeQuietly(channel: ClientChannel | undefined): void {
  try {
    channel?.close()
  } catch {
    // A channel that already closed is the outcome we wanted.
  }
}

/**
 * Opens one direct-tcpip channel to `port` on the host's loopback. A refused connection still
 * proves forwarding is allowed; only the administrative refusal means it is not.
 */
export function probeTcpForwarding(
  connection: Pick<SshConnection, 'getClient'>,
  port: number,
  timeoutMs = TCP_FORWARDING_PROBE_TIMEOUT_MS
): Promise<TcpForwardingVerdict> {
  const client = connection.getClient()
  if (!client) {
    // Why: system SSH opens forwards in its own process; no channel answer reaches us here.
    return Promise.resolve('unverifiable')
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unverifiable'), timeoutMs)
    const settle = (verdict: TcpForwardingVerdict): void => {
      clearTimeout(timer)
      resolve(verdict)
    }
    try {
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) => {
        if (!error) {
          closeQuietly(channel)
          settle('allowed')
          return
        }
        // ssh2 copies the channel-open failure code onto the error as `reason`.
        const reason = 'reason' in error && typeof error.reason === 'number' ? error.reason : null
        settle(
          reason === ADMINISTRATIVELY_PROHIBITED
            ? 'refused'
            : reason === CONNECT_FAILED
              ? 'allowed'
              : 'unverifiable'
        )
      })
    } catch {
      settle('unverifiable')
    }
  })
}
