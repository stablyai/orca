import type { SshConnection } from '../../../ssh/ssh-connection'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { HerdrRuntimeError } from './herdr-runtime-contract'

// Why: the daemon owns SSH connections for remote.attach panes. A connection
// is created by ssh.connect, reused across attaches, and torn down by
// ssh.disconnect or when the daemon stops.

export type SshConnectParams = {
  host: string
  port?: number
  username?: string
  identityFile?: string
  configHost?: string
}

export type DaemonSshEntry = {
  connectionId: string
  connection: SshConnection
  targetId: string
}

export class HerdrDaemonSshStore {
  private readonly entries = new Map<string, DaemonSshEntry>()
  private nextId = 0

  constructor(
    private readonly createConnection: (
      targetId: string,
      params: SshConnectParams,
      onStateChange: (targetId: string, state: SshConnectionState) => void
    ) => SshConnection
  ) {}

  async connect(params: SshConnectParams): Promise<{ connectionId: string; targetId: string }> {
    const connectionId = `ssh-${++this.nextId}`
    const targetId = connectionId
    const connection = this.createConnection(targetId, params, () => {})
    await connection.connect()
    this.entries.set(connectionId, { connectionId, connection, targetId })
    return { connectionId, targetId }
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId)
    if (!entry) {
      throw new HerdrRuntimeError('ssh_not_found', `SSH connection ${connectionId} not found`)
    }
    this.entries.delete(connectionId)
    await entry.connection.disconnect()
  }

  get(connectionId: string): DaemonSshEntry | undefined {
    return this.entries.get(connectionId)
  }

  async disconnectAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.entries.delete(entry.connectionId)
      try {
        await entry.connection.disconnect()
      } catch {
        // Why: best-effort teardown during daemon shutdown.
      }
    }
  }
}
