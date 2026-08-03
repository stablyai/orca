import { STABLE_CONNECTION_MS } from './ssh-reconnect-ladder'

/**
 * Wall-clock budget bounding how long Orca retries an SSH target on its own.
 *
 * Policy: automatic reconnect stops after AUTO_RECONNECT_BUDGET_MS per target and the target stays
 * parked — no timer-based self-heal. Re-arm happens only on new evidence or user intent: a Connect
 * click, a user recovery action (disconnect / terminate sessions / reset relay / remove), a
 * connection that held STABLE_CONNECTION_MS, or a system resume.
 *
 * Why this is target-scoped rather than a field on SshConnection: the ladder in
 * SshReconnectLadder is per-connection-object, and SshConnectionManager.connect()
 * replaces a non-connected connection with a fresh instance. Every SSH pane remount
 * calls ssh.connect(), so a connection-scoped budget is reset to zero indefinitely
 * and the give-up is never reached. Keying by targetId is what makes the stop real.
 */
export const AUTO_RECONNECT_BUDGET_MS = 60_000

export const AUTO_RECONNECT_PAUSED_MESSAGE =
  'The SSH host is unreachable. Automatic reconnect is paused — use Connect to retry.'

/** 'auto' = Orca reconnecting on its own (pane remount, automation); 'user' = an explicit click. */
export type SshConnectInitiator = 'user' | 'auto'

export class SshAutoReconnectBudget {
  private windowStartedAtMs = new Map<string, number>()
  private connectedAtMs = new Map<string, number>()

  constructor(private readonly budgetMs: number = AUTO_RECONNECT_BUDGET_MS) {}

  /** Opens the window on first use and returns the wall-clock deadline for automatic retries. */
  deadlineFor(targetId: string, nowMs: number): number {
    const startedAt = this.windowStartedAtMs.get(targetId)
    if (startedAt === undefined) {
      this.windowStartedAtMs.set(targetId, nowMs)
      return nowMs + this.budgetMs
    }
    return startedAt + this.budgetMs
  }

  /** True once the window has been opened and has elapsed; false while no window is open. */
  isExhausted(targetId: string, nowMs: number): boolean {
    const startedAt = this.windowStartedAtMs.get(targetId)
    return startedAt !== undefined && nowMs - startedAt >= this.budgetMs
  }

  /** A bare handshake earns nothing yet — only surviving to the next drop proves the host is back. */
  markConnected(targetId: string, nowMs: number): void {
    this.connectedAtMs.set(targetId, nowMs)
  }

  /** Consume-once, mirroring SshReconnectLadder: a flap must not roll the window forward each drop. */
  noteDropped(targetId: string, nowMs: number): void {
    const connectedAt = this.connectedAtMs.get(targetId)
    if (connectedAt === undefined) {
      return
    }
    this.connectedAtMs.delete(targetId)
    if (nowMs - connectedAt >= STABLE_CONNECTION_MS) {
      this.windowStartedAtMs.delete(targetId)
    }
  }

  /** Called on user connects and user recovery actions — all re-earn a full budget. */
  reset(targetId: string): void {
    this.windowStartedAtMs.delete(targetId)
    this.connectedAtMs.delete(targetId)
  }

  clear(): void {
    this.windowStartedAtMs.clear()
    this.connectedAtMs.clear()
  }
}

export const sshAutoReconnectBudget = new SshAutoReconnectBudget()
