import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection'

// ── Connection Manager ──────────────────────────────────────────────
// Why: extracted from ssh-connection.ts to keep each file under the
// 300-line oxlint max-lines threshold while preserving a clear
// single-responsibility boundary (connection lifecycle vs. pool management).

export class SshConnectionManager {
  private connections = new Map<string, SshConnection>()
  private callbacks: SshConnectionCallbacks
  // Why: two concurrent connect() calls for the same target would both pass
  // the "existing" check, create two SshConnections, and orphan the first.
  // This set prevents a second call from racing with an in-progress one.
  private connectingTargets = new Set<string>()

  constructor(callbacks: SshConnectionCallbacks) {
    this.callbacks = callbacks
  }

  async connect(target: SshTarget): Promise<SshConnection> {
    const existing = this.connections.get(target.id)
    if (existing?.getState().status === 'connected') {
      return existing
    }

    if (this.connectingTargets.has(target.id)) {
      throw new Error(`Connection to ${target.label} is already in progress`)
    }

    this.connectingTargets.add(target.id)

    try {
      if (existing) {
        await existing.disconnect()
      }

      const conn = new SshConnection(target, this.callbacks)
      this.connections.set(target.id, conn)

      try {
        await conn.connect()
      } catch (err) {
        this.connections.delete(target.id)
        throw err
      }

      return conn
    } finally {
      this.connectingTargets.delete(target.id)
    }
  }

  async disconnect(targetId: string): Promise<void> {
    const conn = this.connections.get(targetId)
    if (!conn) {
      return
    }
    await conn.disconnect()
    this.connections.delete(targetId)
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
    const disconnects = Array.from(this.connections.values()).map((c) => c.disconnect())
    await Promise.allSettled(disconnects)
    this.connections.clear()
  }
}
