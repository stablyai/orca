import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { RECONNECT_BACKOFF_MS } from './ssh-connection-timing'
import {
  isAuthError,
  isPassphraseError,
  isTransientReconnectError
} from '../ssh-reconnect-error-classification'
import { isCancelledConnectAttemptError } from '../ssh-connect-attempt-cancellation'
import { SshReconnectLadder } from '../ssh-reconnect-ladder'
import { isSshUserDisconnected } from '../ssh-user-disconnect'

// Why: resume and the window's own resume/online signal land together; a handshake younger than this
// is the one the first signal just started, not one stuck on the route from before sleep.
const STALE_BACKGROUND_ATTEMPT_MS = 5_000

/** What the reconnect ladder reads from its connection; getters so each read sees the live state. */
export type SshConnectionReconnectHost = {
  targetId: string
  label: string
  isDisposed: () => boolean
  status: () => SshConnectionStatus
  isAwaitingCredential: () => boolean
  /** Claims the next connect generation, superseding any attempt still in flight. */
  claimGeneration: () => number
  currentGeneration: () => number
  isCurrentAttempt: (connectGeneration: number) => boolean
  attemptConnect: (connectGeneration: number) => Promise<void>
  closeTransportsForReconnect: () => void
  /** Written in place without a broadcast; the next setState publishes it. */
  setReconnectAttempt: (attempt: number) => void
  setState: (status: SshConnectionStatus, error?: string) => void
}

/** Background redial after a drop, a wake or a network return, with its backoff timer and ladder. */
export class SshConnectionReconnector {
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reconnectLadder = new SshReconnectLadder()
  private backgroundAttemptStartedAtMs: number | null = null

  constructor(private readonly host: SshConnectionReconnectHost) {}

  /** The first connect resolved: a later drop starts the ladder from the bottom. */
  markInitialConnect(): void {
    this.reconnectLadder.reset()
    this.reconnectLadder.markConnected(Date.now())
  }

  cancelTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = null
  }

  resetLadder(): void {
    this.reconnectLadder.reset()
  }

  async reconnect(): Promise<void> {
    if (!this.mayRedial() || this.host.status() === 'connecting') {
      return
    }
    await this.restartReconnect()
  }

  /**
   * Wake or network return: a spent ladder, a pending backoff, or a background handshake still
   * running from before the route came back restarts now with a fresh budget, since attempts made
   * while asleep (or in a macOS dark wake) say nothing about whether the host is reachable.
   */
  retryAfterNetworkReturn(nowMs: number): boolean {
    if (!this.mayRedial() || this.host.isAwaitingCredential()) {
      return false
    }
    const status = this.host.status()
    const startedAt = this.backgroundAttemptStartedAtMs
    const stalled =
      status === 'reconnection-failed' ||
      (status === 'reconnecting' && this.reconnectTimer !== null) ||
      (status === 'connecting' &&
        startedAt !== null &&
        nowMs - startedAt >= STALE_BACKGROUND_ATTEMPT_MS)
    if (!stalled) {
      return false
    }
    void this.restartReconnect()
    return true
  }

  private async restartReconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Why: OS sleep/wake can leave ssh2 thinking a dead TCP socket is still connected; tear down and reconnect so the relay can reattach remote PTYs.
    this.host.closeTransportsForReconnect()
    this.host.setReconnectAttempt(0)
    this.reconnectLadder.reset()
    this.host.setState('reconnecting')
    await this.runReconnectAttempt()
  }

  // Why: a user's Disconnect is recorded before its teardown disposes this connection, which can
  // wait behind the target's lifecycle; until then a drop, backoff or wake must not redial.
  private mayRedial(): boolean {
    return !this.host.isDisposed() && !isSshUserDisconnected(this.host.targetId)
  }

  scheduleReconnect(): void {
    if (!this.mayRedial() || this.reconnectTimer) {
      return
    }
    const decision = this.reconnectLadder.next(Date.now())
    if (decision.kind === 'give-up') {
      this.host.setState('reconnection-failed', 'Max reconnection attempts reached')
      return
    }
    this.host.setReconnectAttempt(decision.attemptIndex)
    this.host.setState('reconnecting')
    console.warn(
      `[ssh] Reconnecting to ${this.host.label} in ${decision.delayMs}ms (delay step ${decision.attemptIndex + 1}/${RECONNECT_BACKOFF_MS.length}, failed handshakes ${this.reconnectLadder.failedAttemptStreak}/${RECONNECT_BACKOFF_MS.length})`
    )
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.mayRedial()) {
        return
      }
      await this.runReconnectAttempt()
    }, decision.delayMs)
  }

  private async runReconnectAttempt(): Promise<void> {
    const connectGeneration = this.host.claimGeneration()
    this.backgroundAttemptStartedAtMs = Date.now()
    try {
      // Why: reset before connecting so the 'connected' broadcast carries reconnectAttempt=0, which ssh.ts uses to trigger relay re-establishment.
      this.host.setReconnectAttempt(0)
      await this.host.attemptConnect(connectGeneration)
      if (!this.host.isCurrentAttempt(connectGeneration)) {
        return
      }
      // Why: attemptConnect resolves only after a real handshake on either transport; the system-ssh probe's 'connected' must not clear the failure streak.
      this.reconnectLadder.markConnected(Date.now())
    } catch (err) {
      // Why: a superseded attempt has no outcome to publish — the attempt that claimed the generation owns the state, and cancellation is that supersession.
      if (!this.host.isCurrentAttempt(connectGeneration)) {
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      if (isCancelledConnectAttemptError(error)) {
        return
      }
      if (isAuthError(error) || isPassphraseError(error)) {
        this.host.setState('auth-failed', error.message)
        return
      }
      // Why: the system-SSH transport reports timeouts as prose, so the narrow code table would strand FIDO2 targets in 'error' forever.
      if (!isTransientReconnectError(error)) {
        this.host.setState('error', error.message)
        return
      }
      this.reconnectLadder.markAttemptFailed()
      this.scheduleReconnect()
    } finally {
      if (this.host.currentGeneration() === connectGeneration) {
        this.backgroundAttemptStartedAtMs = null
      }
    }
  }
}
