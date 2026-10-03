import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection'

// ── Connection Manager ──────────────────────────────────────────────
// Why: extracted from ssh-connection.ts to keep each file under the
// 300-line oxlint max-lines threshold while preserving a clear
// single-responsibility boundary (connection lifecycle vs. pool management).

// Bounds an owned drain so a host that never confirms close cannot hang its caller.
const OWNED_CONNECTION_DRAIN_TIMEOUT_MS = 10_000

export class SshConnectionManager {
  private connections = new Map<string, SshConnection>()
  private callbacks: SshConnectionCallbacks
  // Why: attempt identity lets disconnect unblock a replacement without the
  // cancelled attempt later clearing the replacement's state.
  private connectingTargets = new Map<string, symbol>()
  // Local operation and teardown bookkeeping; never a verdict on remote process exit.
  private pendingTargetOperations = new Map<string, number>()
  private unconfirmedTargetTeardowns = new Set<string>()
  // Counts every connection a target allocated, retired pool entries included, until it closes.
  private readonly unclosedTransportsByTarget = new Map<string, number>()

  constructor(callbacks: SshConnectionCallbacks) {
    this.callbacks = callbacks
  }

  private registerConnection(targetId: string, connection: SshConnection): void {
    this.unclosedTransportsByTarget.set(
      targetId,
      (this.unclosedTransportsByTarget.get(targetId) ?? 0) + 1
    )
    let observed = false
    connection.subscribeTransportClosure(() => {
      if (observed) {
        return
      }
      observed = true
      const remaining = (this.unclosedTransportsByTarget.get(targetId) ?? 1) - 1
      if (remaining === 0) {
        this.unclosedTransportsByTarget.delete(targetId)
      } else {
        this.unclosedTransportsByTarget.set(targetId, remaining)
      }
    })
    this.connections.set(targetId, connection)
  }

  setCallbacks(callbacks: SshConnectionCallbacks): void {
    this.callbacks = callbacks
    for (const connection of this.connections.values()) {
      connection.setCallbacks(callbacks)
    }
  }

  async connect(target: SshTarget): Promise<SshConnection> {
    return this.trackTargetOperation(target.id, () => this.connectTarget(target))
  }

  private async connectTarget(target: SshTarget): Promise<SshConnection> {
    const existing = this.connections.get(target.id)
    if (existing?.getState().status === 'connected') {
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
      this.registerConnection(target.id, conn)

      try {
        await conn.connect()
      } catch (err) {
        // Why: a failed startup can still hold sockets, so it is disconnected, not just forgotten.
        try {
          await this.disconnectConnection(target.id, conn)
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
    return this.trackTargetOperation(targetId, () => this.disconnectTarget(targetId), true)
  }

  /** Drains only the registered connection for this target; local closure is not remote exit. */
  async disconnectAndDrain(targetId: string, signal: AbortSignal): Promise<void> {
    return this.trackTargetOperation(
      targetId,
      async () => {
        this.connectingTargets.delete(targetId)
        const conn = this.connections.get(targetId)
        if (!conn) {
          return
        }
        await conn.disconnectAndDrain(signal)
        if (this.connections.get(targetId) === conn) {
          this.connections.delete(targetId)
        }
      },
      true
    )
  }

  private async disconnectTarget(targetId: string): Promise<void> {
    // Why: disconnect invalidates the old attempt immediately so a reconnect
    // need not wait for the cancelled socket's late completion.
    this.connectingTargets.delete(targetId)
    const conn = this.connections.get(targetId)
    if (!conn) {
      return
    }
    await conn.disconnect()
    if (this.connections.get(targetId) === conn) {
      this.connections.delete(targetId)
    }
  }

  /**
   * Close one specific connection, clearing the pool entry only when it is still the registered one.
   * Why: a cancelled connect whose transport opened late owns that exact connection — disconnecting
   * by target id would tear down the replacement's live transport instead.
   */
  async disconnectConnection(targetId: string, conn: SshConnection, drain = false): Promise<void> {
    return this.trackTargetOperation(
      targetId,
      async () => {
        await (drain
          ? conn.disconnectAndDrain(AbortSignal.timeout(OWNED_CONNECTION_DRAIN_TIMEOUT_MS))
          : conn.disconnect())
        if (this.connections.get(targetId) === conn) {
          this.connections.delete(targetId)
        }
      },
      true
    )
  }

  async reconnect(targetId: string): Promise<void> {
    const conn = this.connections.get(targetId)
    if (!conn) {
      return
    }
    await this.trackTargetOperation(targetId, () => conn.reconnect())
  }

  private async trackTargetOperation<T>(
    targetId: string,
    operation: () => Promise<T>,
    retainFailure = false
  ): Promise<T> {
    this.pendingTargetOperations.set(
      targetId,
      (this.pendingTargetOperations.get(targetId) ?? 0) + 1
    )
    try {
      return await operation()
    } catch (error) {
      if (retainFailure) {
        this.unconfirmedTargetTeardowns.add(targetId)
      }
      throw error
    } finally {
      const remaining = (this.pendingTargetOperations.get(targetId) ?? 1) - 1
      if (remaining === 0) {
        this.pendingTargetOperations.delete(targetId)
      } else {
        this.pendingTargetOperations.set(targetId, remaining)
      }
    }
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

  async disconnectAll(shouldDisconnect: (targetId: string) => boolean = () => true): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections).map(async ([targetId, connection]) => {
        if (!shouldDisconnect(targetId)) {
          return
        }
        await this.trackTargetOperation(
          targetId,
          async () => {
            try {
              await connection.disconnect()
            } finally {
              // A later registration or an excluded target is not this drain's to remove.
              if (this.connections.get(targetId) === connection) {
                this.connections.delete(targetId)
              }
            }
          },
          true
        )
      })
    )
  }
}
