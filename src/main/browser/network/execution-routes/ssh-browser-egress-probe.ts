import type { SshConnection } from '../../../ssh/connection/ssh-connection'
import {
  probeTcpForwarding,
  type TcpForwardingVerdict
} from '../../../ssh/port-forwarding/ssh-tcp-forwarding-probe'
import { lastChannelOpenFailure } from '../../../ssh/port-forwarding/system-ssh-port-forward-provider'
import type { SystemSshDynamicForwardProcess } from '../../../ssh/system-transport/forwarding/system-ssh-dynamic-forward-process'
import { openConnectedSocket } from '../tunnels/browser-network-connected-socket'
import { SystemSshSocksClientSocket } from '../tunnels/system-ssh-socks-client-socket'

/**
 * A non-loopback literal every OS refuses at once (nothing listens on its discard port), so a host
 * that forwards normally answers "connect failed" fast, while a host that forwards only to its own
 * loopback, or not at all, answers "administratively prohibited".
 */
const EGRESS_PROBE_TARGET = { host: '0.0.0.0', port: 9 } as const
const EGRESS_PROBE_TIMEOUT_MS = 4_000
// ssh logs a refused open just before it drops the SOCKS client; the two can arrive out of order.
const FAILURE_LOG_GRACE_MS = 500

/** `refused` only on the host's own policy answer; anything unclear keeps direct forwarding. */
export function probeSsh2BrowserEgress(
  connection: Pick<SshConnection, 'getClient'>
): Promise<TcpForwardingVerdict> {
  return probeTcpForwarding(
    connection,
    EGRESS_PROBE_TARGET.port,
    EGRESS_PROBE_TIMEOUT_MS,
    EGRESS_PROBE_TARGET.host
  )
}

export function probeSystemSshBrowserEgress(
  forward: Pick<SystemSshDynamicForwardProcess, 'localPort' | 'stderrTail' | 'process'>
): Promise<TcpForwardingVerdict> {
  const logOffset = forward.stderrTail().length
  const verdictOf = (): TcpForwardingVerdict | null => {
    const reason = lastChannelOpenFailure(forward.stderrTail().slice(logOffset))
    return reason === 'administratively-prohibited'
      ? 'refused'
      : reason === 'connect-failed'
        ? 'allowed'
        : null
  }
  return new Promise((resolve) => {
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const socket = new SystemSshSocksClientSocket(EGRESS_PROBE_TARGET, (signal) =>
      openConnectedSocket({ host: '127.0.0.1', port: forward.localPort }, signal)
    )
    const settle = (verdict: TcpForwardingVerdict): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      forward.process.stderr?.off('data', onLog)
      socket.destroy()
      resolve(verdict)
    }
    // Registered after the forward's own stderr reader, so its tail already holds this chunk.
    const onLog = (): void => {
      const verdict = verdictOf()
      if (verdict) {
        settle(verdict)
      }
    }
    const onDropped = (): void => {
      onLog()
      grace ??= setTimeout(() => settle(verdictOf() ?? 'unverifiable'), FAILURE_LOG_GRACE_MS)
    }
    const timer = setTimeout(() => settle(verdictOf() ?? 'unverifiable'), EGRESS_PROBE_TIMEOUT_MS)
    forward.process.stderr?.on('data', onLog)
    // ssh answers the SOCKS request only once the host opened the channel.
    socket.on('connect', () => settle('allowed'))
    // The dial is half-open: a dropped request arrives as `end`, not `close`.
    socket.on('end', onDropped)
    socket.on('error', onDropped)
    socket.on('close', onDropped)
  })
}
