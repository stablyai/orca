import type { PortForwardEntry } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'

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

export type StartedPortForward = {
  entry: PortForwardEntry
  close: () => Promise<void>
  dispose: () => void
}

export type SshPortForwardProvider = {
  canHandle(conn: SshConnection): boolean
  start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward>
}
