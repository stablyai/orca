import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../../../ssh/connection/ssh-connection'
import { RELAY_REMOTE_DIR } from '../../../managed-server/install/remote-install-root'
import {
  launchBrowserNetworkRelay,
  type BrowserNetworkRelayChild
} from './browser-network-relay-launch'
import { attachBrowserNetworkRelayTunnel } from './browser-network-relay-tunnel'
import { openExecutionRouteSocketAsDuplex } from '../tunnels/execution-route-socket-duplex'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route-contract'
import {
  finishSshBrowserNetworkRoute,
  isSshBrowserNetworkRouteBaseCurrent,
  type SshBrowserNetworkRouteBase
} from './ssh-browser-network-route-base'

export type LaunchHostRelay = (
  connection: SshConnection,
  signal: AbortSignal
) => Promise<BrowserNetworkRelayChild>

const SSH_BROWSER_NETWORK_RELAY_DIR = `${RELAY_REMOTE_DIR}/browser-network`

/**
 * Runs the browser relay in an exec session on the SSH host, for hosts that refuse to forward
 * to anything but their own loopback. It dials out as the SSH user, like any terminal command,
 * and opens no listener; closing the session ends it.
 */
export function launchSshBrowserNetworkHostRelay(
  connection: Pick<SshConnection, 'exec'>,
  signal: AbortSignal
): Promise<BrowserNetworkRelayChild> {
  return launchBrowserNetworkRelay(
    {
      homeDir: SSH_BROWSER_NETWORK_RELAY_DIR,
      run: async (command) => sshExecRelayChild(await connection.exec(command, { signal }))
    },
    signal
  )
}

/** Null when the relay cannot run there (no Node 18+, or not a POSIX host); the caller keeps forwarding. */
export async function createSshHostRelayRoute(
  base: SshBrowserNetworkRouteBase,
  launchHostRelay: LaunchHostRelay
): Promise<BrowserNetworkExecutionRoute | null> {
  let child: BrowserNetworkRelayChild
  try {
    child = await launchHostRelay(base.connection, base.invalidation.signal)
  } catch {
    if (!base.invalidation.signal.aborted) {
      return null
    }
    base.releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  const tunnel = attachBrowserNetworkRelayTunnel(child, base.invalidation.signal)
  void tunnel.whenInvalidated.then(() => base.invalidation.abort())
  if (!isSshBrowserNetworkRouteBaseCurrent(base)) {
    tunnel.close()
    base.releaseInvalidation()
    throw new Error('browser_tunnel_execution_host_stale')
  }
  return finishSshBrowserNetworkRoute(base, {
    isValid: tunnel.isValid,
    close: tunnel.close,
    dialer: {
      connect: tunnel.connect,
      // Through the deferred socket, so a proxy's bytes return receive credit like direct ones.
      openTransport: (endpoint, signal) => {
        const socket = tunnel.connect(endpoint)
        signal.addEventListener('abort', () => socket.destroy(), { once: true })
        return openExecutionRouteSocketAsDuplex(socket)
      }
    }
  })
}

function sshExecRelayChild(channel: ClientChannel): BrowserNetworkRelayChild {
  const events = new EventEmitter()
  let ended = false
  // An unread stdout never ends, so the channel's own close can wait forever; the exit status cannot.
  const end = (code: number | null): void => {
    if (!ended) {
      ended = true
      events.emit('close', code)
    }
  }
  channel.on('exit', (code: unknown) => end(typeof code === 'number' ? code : null))
  channel.on('close', () => end(null))
  channel.on('error', (error: Error) => events.emit('error', error))
  return Object.assign(events, {
    stdin: channel.stdin,
    // System SSH channels carry stdout on the duplex itself, as ssh2 channels also do.
    stdout: channel,
    stderr: channel.stderr,
    kill: () => {
      try {
        channel.close()
      } catch {
        // A channel that already closed is the outcome we wanted.
      }
    }
  })
}
