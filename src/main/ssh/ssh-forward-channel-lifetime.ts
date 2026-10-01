import type { Client } from 'ssh2'
import {
  trackSshConnectionChannelLifetime,
  type SshChannelErrorReporter
} from './ssh-connection-channel-lifetime'
import type {
  SshConnectionWorkChannel,
  SshConnectionWorkLedger
} from './ssh-connection-work-ledger'

/** A forward must ride the connection's current client, never one a reconnect replaced. */
export function assertSshForwardClient(current: Client | null, requested: Client): void {
  if (current !== requested) {
    throw new Error('ssh_connection_forward_client_changed')
  }
}

/** Remote stream-local forwarding needs a live ssh2 transport and an absolute Unix socket path. */
export function assertSshStreamLocalForwardAllowed(
  transportUsable: boolean,
  socketPath: string
): void {
  if (!transportUsable) {
    throw new Error('ssh_connection_streamlocal_transport_unavailable')
  }
  if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
    throw new Error('ssh_connection_streamlocal_endpoint_invalid')
  }
}

/** The channel remains tracked until physical close, including late open replies. */
export function forwardTrackedSshStreamLocalChannel(
  ledger: SshConnectionWorkLedger,
  client: Client,
  onUnhandledError: SshChannelErrorReporter | undefined,
  ...args: Parameters<Client['openssh_forwardOutStreamLocal']>
): void {
  const opening = ledger.beginChannelOpen()
  const [socketPath, callback] = args
  try {
    client.openssh_forwardOutStreamLocal(socketPath, (error, channel) => {
      if (error) {
        opening.close(error)
      } else {
        trackSshConnectionChannelLifetime(opening, channel, onUnhandledError)
      }
      callback(error, channel)
    })
  } catch (error) {
    opening.markUnverifiable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

export function forwardTrackedSshChannel(
  ledger: SshConnectionWorkLedger,
  client: Client,
  localSocket: SshConnectionWorkChannel,
  onUnhandledError: SshChannelErrorReporter | undefined,
  ...args: Parameters<Client['forwardOut']>
): void {
  const opening = ledger.beginChannelOpen()
  trackSshConnectionChannelLifetime(ledger.beginChannelOpen(), localSocket, onUnhandledError)
  const [sourceHost, sourcePort, host, port, callback] = args
  try {
    client.forwardOut(sourceHost, sourcePort, host, port, (error, channel) => {
      if (error) {
        opening.close(error)
      } else {
        trackSshConnectionChannelLifetime(opening, channel, onUnhandledError)
      }
      callback?.(error, channel)
    })
  } catch (error) {
    opening.markUnverifiable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
