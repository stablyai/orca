import type { SshTarget, SshConnectionState } from '../../../shared/ssh-types'
import { SshConnection, type SshCachedCredentials } from './ssh-connection'
import type { SshConnectionCallbacks } from './ssh-connection-callbacks'
import { recordSshConnectionOpened, recordSshConnectionReused } from './ssh-connection-attribution'
import {
  createSshCredentialDeclinedError,
  isSshCredentialDeclined
} from '../ssh-credential-decline'
import { createSshUserDisconnectedError, isSshUserDisconnected } from '../ssh-user-disconnect'
import { SSH_CONNECT_IN_PROGRESS_SUFFIX } from '../../../shared/ssh-sign-in-required-copy'

/** A remembered sign-in only applies to the endpoint it was given for; an edited host must ask. */
function signInEndpoint(target: SshTarget): string {
  const { configHost, host, port, username, identityFile, proxyCommand, jumpHost } = target
  return JSON.stringify([configHost, host, port, username, identityFile, proxyCommand, jumpHost])
}

export class SshConnectionManager {
  private connections = new Map<string, SshConnection>()
  // Retain sign-in across automatic replacement closes; explicit disconnect still forgets credentials.
  private retainedSignIns = new Map<
    string,
    { endpoint: string; credentials: SshCachedCredentials }
  >()
  private callbacks: SshConnectionCallbacks
  // Attempt tokens let replacement connect proceed without stale cancellation clearing its state.
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

  /** `probe`: a user's connection test, which a Disconnect does not refuse. */
  async connect(target: SshTarget, options?: { probe?: boolean }): Promise<SshConnection> {
    // Refuse user-disconnected hosts before pool reuse, including transports opened by connection tests (#30086).
    if (!options?.probe && isSshUserDisconnected(target.id)) {
      throw createSshUserDisconnectedError(target.label)
    }
    const existing = this.connections.get(target.id)
    if (existing?.getState().status === 'connected') {
      recordSshConnectionReused(existing)
      return existing
    }

    // Do not repeatedly redial or reprompt after the user declines a background sign-in.
    if (isSshCredentialDeclined(target.id)) {
      throw createSshCredentialDeclinedError(target.id, target.label)
    }

    // Reusing/replacing an active credential request would close the dialog the user is answering.
    if (this.connectingTargets.has(target.id) || existing?.isAwaitingCredential()) {
      throw new Error(`Connection to ${target.label} ${SSH_CONNECT_IN_PROGRESS_SUFFIX}`)
    }

    const attempt = Symbol(target.id)
    this.connectingTargets.set(target.id, attempt)

    try {
      if (existing) {
        this.retainSignIn(target.id, existing)
        await existing.disconnect()
        // A Disconnect/Remove during old close must not let this attempt revive the host.
        if (this.connectingTargets.get(target.id) !== attempt) {
          throw new Error(`Connection to ${target.label} was cancelled`)
        }
      }

      const conn = new SshConnection(target, this.callbacks, this.takeRetainedSignIn(target))
      recordSshConnectionOpened(conn)
      this.connections.set(target.id, conn)

      try {
        await conn.connect()
      } catch (err) {
        // Failed startup may retain sockets; close quietly so cleanup cannot overwrite its published error.
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
    // Invalidate immediately so replacement connect need not wait for late socket completion.
    this.connectingTargets.delete(targetId)
    this.retainedSignIns.delete(targetId)
    const conn = this.connections.get(targetId)
    if (conn) {
      await this.closeConnection(targetId, conn)
    }
  }

  /** Close the captured connection and clear only its own pool entry; target-id teardown could kill a newer replacement. */
  async disconnectConnection(
    targetId: string,
    conn: SshConnection,
    options?: { quiet?: boolean }
  ): Promise<void> {
    this.retainSignIn(targetId, conn)
    await this.closeConnection(targetId, conn, options)
  }

  private async closeConnection(
    targetId: string,
    conn: SshConnection,
    options?: { quiet?: boolean }
  ): Promise<void> {
    await conn.disconnect(options)
    if (this.connections.get(targetId) === conn) {
      this.connections.delete(targetId)
    }
  }

  /** Only the registered connection speaks for the target; a stale one may hold an older sign-in. */
  private retainSignIn(targetId: string, conn: SshConnection): void {
    if (this.connections.get(targetId) !== conn) {
      return
    }
    const credentials = conn.getReusableCredentials()
    if (credentials) {
      this.retainedSignIns.set(targetId, {
        endpoint: signInEndpoint(conn.getTarget()),
        credentials
      })
    } else {
      this.retainedSignIns.delete(targetId)
    }
  }

  private takeRetainedSignIn(target: SshTarget): SshCachedCredentials | undefined {
    const retained = this.retainedSignIns.get(target.id)
    this.retainedSignIns.delete(target.id)
    return retained?.endpoint === signInEndpoint(target) ? retained.credentials : undefined
  }

  hasCachedCredential(target: SshTarget): boolean {
    const retained = this.retainedSignIns.get(target.id)
    return (
      this.connections.get(target.id)?.hasCachedCredential() === true ||
      retained?.endpoint === signInEndpoint(target)
    )
  }

  async reconnect(targetId: string): Promise<void> {
    const conn = this.connections.get(targetId)
    if (!conn) {
      return
    }
    await conn.reconnect()
  }

  /** Restarts every reconnect stalled on a backoff, a spent ladder, or a pre-wake handshake. */
  retryStalledReconnects(): string[] {
    const restarted: string[] = []
    for (const [targetId, conn] of this.connections) {
      if (conn.retryAfterNetworkReturn()) {
        restarted.push(targetId)
      }
    }
    return restarted
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
    this.retainedSignIns.clear()
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
