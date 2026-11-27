import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import type { SshConnection } from '../connection/ssh-connection'

export type PortForwardCloseReason =
  | { kind: 'removed' }
  | { kind: 'unexpected-exit'; detail?: string }

export type PortForwardStartOptions = {
  id: string
  connectionId: string
  localHost: '127.0.0.1'
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
  onUnexpectedClose?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export type ForwardChannelOpenFailure = 'administratively-prohibited' | 'connect-failed'

/** What a forward rides: an SSH session, or a paired server's tunnel. */
export type PortForwardConnection = { isDisposed(): boolean }

export type StartedPortForward<TConnection extends PortForwardConnection = SshConnection> = {
  entry: PortForwardEntry
  close: () => Promise<void>
  dispose: () => void
  /** False when this connection no longer owns the forwarded transport. */
  isLive?: (conn: TConnection) => boolean
  /** Forwards run by an out-of-process client, whose channel answers reach only its stderr. */
  lastChannelOpenFailure?: () => ForwardChannelOpenFailure | null
}

export type SshPortForwardProvider<TConnection extends PortForwardConnection = SshConnection> = {
  canHandle(conn: TConnection): boolean
  start(
    conn: TConnection,
    options: PortForwardStartOptions
  ): Promise<StartedPortForward<TConnection>>
}
