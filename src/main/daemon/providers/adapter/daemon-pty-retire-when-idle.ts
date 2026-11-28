import { DaemonPtySessionInventory } from './daemon-pty-session-inventory'
import { RETIRE_WHEN_IDLE_REQUEST } from '../../server/daemon-superseded-clients'
import { isDaemonEndpointGoneError } from '../../protocol/daemon-errors'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import { preservedDaemonProcessExited } from './daemon-preserved-endpoint-loss'

/** An older generation asked to retire by itself once it owns nothing (`retireWhenIdle`). */
export abstract class DaemonPtyRetireWhenIdle extends DaemonPtySessionInventory {
  /** The live connection asked the daemon to retire when idle. */
  private heldForRetirement = false
  /** A held connection dropped and nothing has reconnected since: the daemon may have retired. */
  private heldConnectionDropped = false
  /** The newer protocol that asked; every new connection is asked again. */
  private retireWhenIdleFor: number | null = null
  private stopHeldWatch: (() => void) | null = null

  /** Asks an older generation to retire by itself once it owns nothing; 'unsupported' predates the request. */
  async askRetireWhenIdle(
    currentProtocolVersion: number
  ): Promise<'held' | 'unsupported' | 'unanswered'> {
    this.retireWhenIdleFor = currentProtocolVersion
    this.stopHeldWatch ??= this.watchHeldConnection()
    try {
      await this.ensureConnected()
      await this.sendRetireWhenIdle()
      return 'held'
    } catch (error) {
      if (!isUnknownRequestTypeError(error)) {
        return 'unanswered'
      }
      this.retireWhenIdleFor = null
      return 'unsupported'
    }
  }

  private async sendRetireWhenIdle(): Promise<void> {
    const currentProtocolVersion = this.retireWhenIdleFor
    await this.client.request(RETIRE_WHEN_IDLE_REQUEST, { currentProtocolVersion })
    this.heldForRetirement = true
    this.heldConnectionDropped = false
  }

  // Any reconnection, including one relay code makes on this client, is asked again.
  private watchHeldConnection(): () => void {
    const stopDropped = this.client.onDisconnected(() => {
      this.heldConnectionDropped ||= this.heldForRetirement
      this.heldForRetirement = false
    })
    const stopConnected = this.client.connectedListeners.add(() => {
      if (this.retireWhenIdleFor !== null) {
        this.sendRetireWhenIdle().catch(() => {})
      }
    })
    return () => {
      stopDropped()
      stopConnected()
    }
  }

  /** After contact with a generation asked to retire is lost: retired only with its endpoint and process gone. */
  async confirmRetiredWhenIdle(): Promise<'retired' | 'connected' | 'reconnected' | 'unknown'> {
    if (this.idleRetirementState === 'retiring') {
      return 'retired'
    }
    if (this.client.isConnected()) {
      return 'connected'
    }
    const asked = this.heldConnectionDropped || this.idleRetirementState === 'unverifiable'
    if (!asked || this.activeSessionIds.size > 0) {
      return 'unknown'
    }
    try {
      await this.ensureConnected()
      this.heldConnectionDropped = false
      return 'reconnected'
    } catch (error) {
      // A missing name alone proves nothing on POSIX, where something else may have unlinked it.
      if (
        !isDaemonEndpointGoneError(error) ||
        this.activeSessionIds.size > 0 ||
        !preservedDaemonProcessExited(this.lastAuthenticatedIdentity?.pid)
      ) {
        return 'unknown'
      }
      this.idleRetirementState = 'retiring'
      this.idleRetirementAdmissionClosed = true
      this.respawnAdoptionClosed = true
      return 'retired'
    }
  }

  /** Asked to retire on the live connection; the daemon may decide at any moment. */
  isHeldForRetirement(): boolean {
    return this.heldForRetirement
  }

  /** Asked to retire, on the live connection or on one that dropped since. */
  wasAskedToRetireWhenIdle(): boolean {
    return this.heldForRetirement || this.heldConnectionDropped
  }

  onConnectionLost(listener: () => void): () => void {
    return this.client.onDisconnected(listener)
  }

  protected stopRetireWhenIdleWatch(): void {
    this.stopHeldWatch?.()
    this.stopHeldWatch = null
  }
}
