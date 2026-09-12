import type { PortForwardEntry } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'

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
  assertAdmission?: () => void
  onUnexpectedClose?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export type StartedPortForward = {
  entry: PortForwardEntry
  close: () => Promise<void>
  dispose: () => void
  /** True only after local closure and host-confirmed retirement, never just a resolved close call. */
  readonly retirementConfirmed?: boolean
  /** Exact host reset preparation plus local listener closure, distinct from ordinary Close. */
  readonly resetRetirementConfirmed?: RelayOwnerResetRequest
  readonly supportsResetRetirement?: true
  fenceForDrain?: () => {
    drain: (signal: AbortSignal) => Promise<void>
    assertDrained: () => void
  }
}

export type SshPortForwardProvider = {
  canHandle(conn: SshConnection): boolean
  start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward>
}
