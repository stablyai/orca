import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection'
import { recordSshConnectionOpened, recordSshConnectionReused } from './ssh-connection-attribution'

export class SshConnectionManager {
  private connections = new Map<string, SshConnection>()
  private callbacks: SshConnectionCallbacks
  // Why: attempt identity lets disconnect unblock a replacement without the
  // cancelled attempt later clearing the replacement's state.
  private connectingTargets = new Map<string, symbol>()

  constructor(callbacks: SshConnectionCallbacks) {
    this.callbacks = callbacks
  }

  setCallbacks(callbacks: SshConnectionCallbacks): void {
    this.callbacks = callbacks
    for (const connection of this.connections.values()) {
      connection.setCallbacks(callbacks)
    }
  }

  async connect(target: SshTarget): Promise<SshConnection> {
    const existing = this.connections.get(target.id)
    if (existing?.getState().status === 'connected') {
      recordSshConnectionReused(existing)
      return existing
    }

    if (this.connectingTargets.has(target.id)) {
      throw new Error(`Connection to ${target.label} is already in progress`)
    }

    const attempt = Symbol(target.id)
    this.connectingTargets.set(target.id, attempt)

    try {
      if (existing) {
        await existing.disconnect()
      }

      const conn = new SshConnection(target, this.callbacks)
      recordSshConnectionOpened(conn)
      this.connections.set(target.id, conn)

      try {
        await conn.connect()
      } catch (err) {
        // Why: a failed startup can still hold sockets, so it is disconnected, not just forgotten;
        // quietly, so its published error is not replaced by a plain disconnect.
        try {
          await this.disconnectConnection(target.id, conn, { quiet: true })
        } catch (cleanupError) {
          throw new AggregateError([err, cleanupError], 'ssh_connection_startup_cleanup_failed')
        }
        throw err
      }

      return conn
    } finally {
      if (this.connectingTargets.get(target.id) === attempt) {
        this.connectingTargets.delete(target.id)
      }
    }
  }

  async disconnect(targetId: string): Promise<void> {
    // Why: disconnect invalidates the old attempt immediately so a reconnect
    // need not wait for the cancelled socket's late completion.
    this.connectingTargets.delete(targetId)
    const conn = this.connections.get(targetId)
    if (conn) {
      await this.disconnectConnection(targetId, conn)
    }
  }

  /**
   * Close one specific connection, clearing the pool entry only when it is still the registered one.
   * Why: a cancelled connect whose transport opened late owns that exact connection — disconnecting
   * by target id would tear down the replacement's live transport instead.
   */
  async disconnectConnection(
    targetId: string,
    conn: SshConnection,
    options?: { quiet?: boolean }
  ): Promise<void> {
    await conn.disconnect(options)
    if (this.connections.get(targetId) === conn) {
      this.connections.delete(targetId)
    }
  }

  async reconnect(targetId: string): Promise<void> {
    const conn = this.connections.get(targetId)
    if (!conn) {
      return
    }
    await conn.reconnect()
  }

  getConnection(targetId: string): SshConnection | undefined {
    return this.connections.get(targetId)
  }

  getState(targetId: string): SshConnectionState | null {
    return this.connections.get(targetId)?.getState() ?? null
  }

  getAllStates(): Map<string, SshConnectionState> {
    const states = new Map<string, SshConnectionState>()
    for (const [id, conn] of this.connections) {
      states.set(id, conn.getState())
    }
    return states
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections).map(async ([targetId, connection]) => {
        try {
          await connection.disconnect()
        } finally {
          // A later registration is not this drain's to remove.
          if (this.connections.get(targetId) === connection) {
            this.connections.delete(targetId)
          }
        }
      })
    )
  }
}
