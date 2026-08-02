import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection'

// ── Connection Manager ──────────────────────────────────────────────
// Why: extracted from ssh-connection.ts to keep each file under the
// 300-line oxlint max-lines threshold while preserving a clear
// single-responsibility boundary (connection lifecycle vs. pool management).

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
      this.connections.set(target.id, conn)

      try {
        await conn.connect()
      } catch (err) {
        if (this.connections.get(target.id) === conn) {
          this.connections.delete(target.id)
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
    if (!conn) {
      return
    }
    await conn.disconnect()
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
    const disconnects = Array.from(this.connections.values()).map((c) => c.disconnect())
    await Promise.allSettled(disconnects)
    this.connections.clear()
  }
}
