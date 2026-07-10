import type {
  AgentAutoResumeEntry,
  AgentAutoResumePhase,
  AgentAutoResumeSnapshot,
  UsageLimitProvider,
  UsageLimitStallReason
} from '../shared/agent-auto-resume-types'
import type { UsageLimitStallEvent, UsageLimitStallSnapshot } from './runtime/orca-runtime'

// Why: after a banner's reset time, give the provider a short cushion before
// resending so the agent CLI has actually cleared the limit server-side.
export const BANNER_RESET_GRACE_MS = 90 * 1000
// Why: some banners print no parseable reset (and the provider quota probe may
// be unavailable). Retry conservatively rather than hammering the CLI.
export const BANNER_UNKNOWN_RESET_DELAY_MS = 5 * 60 * 1000
// Why: after resending, wait before checking whether the agent recovered; a
// real resume flips the title to "working" within this window.
export const POST_SEND_VERIFY_MS = 45 * 1000
// Product rule: cap attempts and always notify on give-up.
export const MAX_RESUME_ATTEMPTS = 2

export type AgentAutoResumeNotificationKind = 'detected' | 'failed' | 'dead-pty'

export type AgentAutoResumeNotification = {
  kind: AgentAutoResumeNotificationKind
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  resumesAt: number | null
}

type SendKeysAction = { text?: string; enter?: boolean }

export type AgentAutoResumeServiceOptions = {
  /** Re-verify a stall against the live PTY tail immediately before acting. */
  verifyStall: (ptyId: string) => UsageLimitStallSnapshot | null
  /** Write keystrokes to the agent terminal identified by its runtime handle. */
  sendKeys: (handle: string, action: SendKeysAction) => Promise<void>
  /** The user-configured agent idle timeout, reused as the menu grace period. */
  getMenuGraceMs: () => number
  /** resetsAt from RateLimitService for the provider, if known. */
  getProviderResetAt?: (provider: UsageLimitProvider | null) => number | null
  /** Fire a native/mobile notification (already gated by NotificationSettings). */
  notify?: (notification: AgentAutoResumeNotification) => void
  /** Push the current tracked-entry snapshot to the renderer. */
  onSnapshot?: (snapshot: AgentAutoResumeSnapshot) => void
  now?: () => number
  logger?: Pick<Console, 'debug' | 'warn'>
}

type TrackedStall = {
  ptyId: string
  handle: string | null
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  resetsAt: number | null
  detectedAt: number
  phase: AgentAutoResumePhase
  attempts: number
  resumesAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Watches for usage-limit stall events (from the runtime's live PTY scan) and,
 * when the opt-in setting is on, auto-resumes the agent:
 *
 *  - `usage-limit-menu`: wait the user's configured idle timeout so a human can
 *    intervene, then — if the menu is still live — press Enter to select "Stop
 *    and wait for limit to reset". The CLI then owns its own countdown/resume.
 *  - `usage-limit-banner`: arm a timer for max(banner resetsAt, provider
 *    resetsAt) + grace, re-verify the banner is still on screen, then resend
 *    "continue". Retry once more on failure, then give up and notify.
 *  - PTY exit while limited: notify (the dead-PTY path is handed to the
 *    renderer's sleeping-agent resume flow on worktree activation).
 *
 * Every action is gated on a fresh re-verification against the live tail — the
 * service never acts on stale content and never pokes a working agent.
 */
export class AgentAutoResumeService {
  private enabled = false
  private readonly tracked = new Map<string, TrackedStall>()
  private readonly opts: AgentAutoResumeServiceOptions
  private readonly now: () => number
  private readonly logger: Pick<Console, 'debug' | 'warn'>

  constructor(options: AgentAutoResumeServiceOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return
    }
    this.enabled = enabled
    if (!enabled) {
      // Why: disabling must immediately drop every pending timer so a
      // mid-flight grace/reset wait can't fire keystrokes after opt-out.
      for (const stall of this.tracked.values()) {
        this.clearTimer(stall)
      }
      this.tracked.clear()
    }
    this.emitSnapshot()
  }

  handleEvent(event: UsageLimitStallEvent): void {
    if (event.kind === 'detected') {
      this.onDetected(event)
      return
    }
    if (event.kind === 'cleared') {
      this.onCleared(event.ptyId)
      return
    }
    this.onExited(event)
  }

  dispose(): void {
    for (const stall of this.tracked.values()) {
      this.clearTimer(stall)
    }
    this.tracked.clear()
  }

  private onDetected(event: Extract<UsageLimitStallEvent, { kind: 'detected' }>): void {
    if (!this.enabled) {
      return
    }
    const existing = this.tracked.get(event.ptyId)
    // Dedup: an active wait for the same stall must not re-arm on redraw churn.
    // Only a changed reason (or a stall we already resolved) re-arms.
    if (
      existing &&
      (existing.phase === 'waiting' || existing.phase === 'acting') &&
      existing.reason === event.reason
    ) {
      existing.handle = event.handle ?? existing.handle
      return
    }
    if (existing) {
      this.clearTimer(existing)
    }
    const stall: TrackedStall = {
      ptyId: event.ptyId,
      handle: event.handle,
      worktreeId: event.worktreeId,
      paneKey: event.paneKey,
      provider: event.provider,
      reason: event.reason,
      resetsAt: event.resetsAt,
      detectedAt: event.detectedAt,
      phase: 'waiting',
      attempts: 0,
      resumesAt: null,
      timer: null
    }
    this.tracked.set(event.ptyId, stall)
    this.armActionTimer(stall)
    this.opts.notify?.({
      kind: 'detected',
      worktreeId: stall.worktreeId,
      paneKey: stall.paneKey,
      provider: stall.provider,
      reason: stall.reason,
      resumesAt: stall.resumesAt
    })
    this.emitSnapshot()
  }

  private onCleared(ptyId: string): void {
    const stall = this.tracked.get(ptyId)
    if (!stall) {
      return
    }
    this.clearTimer(stall)
    this.tracked.delete(ptyId)
    this.emitSnapshot()
  }

  private onExited(event: Extract<UsageLimitStallEvent, { kind: 'exited' }>): void {
    const stall = this.tracked.get(event.ptyId)
    if (!stall) {
      return
    }
    this.clearTimer(stall)
    this.tracked.delete(event.ptyId)
    this.opts.notify?.({
      kind: 'dead-pty',
      worktreeId: event.worktreeId,
      paneKey: event.paneKey,
      provider: stall.provider,
      reason: stall.reason,
      resumesAt: null
    })
    this.emitSnapshot()
  }

  private armActionTimer(stall: TrackedStall): void {
    const now = this.now()
    const resumesAt =
      stall.reason === 'usage-limit-menu'
        ? now + Math.max(0, this.opts.getMenuGraceMs())
        : this.computeBannerResumeAt(stall, now)
    stall.resumesAt = resumesAt
    stall.phase = 'waiting'
    const delay = Math.max(0, resumesAt - now)
    stall.timer = this.schedule(() => {
      void this.onActionDue(stall.ptyId)
    }, delay)
  }

  private computeBannerResumeAt(stall: TrackedStall, now: number): number {
    const providerResetAt = this.opts.getProviderResetAt?.(stall.provider) ?? null
    const target = Math.max(stall.resetsAt ?? 0, providerResetAt ?? 0)
    if (target <= 0) {
      return now + BANNER_UNKNOWN_RESET_DELAY_MS
    }
    // A reset already in the past means the limit should have cleared — act
    // after the grace cushion measured from now, not from the stale timestamp.
    return Math.max(target, now) + BANNER_RESET_GRACE_MS
  }

  private async onActionDue(ptyId: string): Promise<void> {
    const stall = this.tracked.get(ptyId)
    if (!stall) {
      return
    }
    stall.timer = null
    stall.phase = 'acting'
    const snapshot = this.opts.verifyStall(ptyId)
    // Product rule #6: never act on stale data. If the banner/menu is gone or
    // the agent is already working, it recovered on its own — stop quietly.
    if (!snapshot || !snapshot.present || snapshot.agentWorking) {
      this.tracked.delete(ptyId)
      this.emitSnapshot()
      return
    }
    const handle = snapshot.handle ?? stall.handle
    if (!handle) {
      this.giveUp(stall, 'no-handle')
      return
    }
    stall.attempts += 1
    try {
      if (stall.reason === 'usage-limit-menu') {
        // Enter selects the highlighted default option 1 ("Stop and wait for
        // limit to reset"); the CLI then runs its own countdown + resume.
        await this.opts.sendKeys(handle, { enter: true })
        this.tracked.delete(ptyId)
        this.emitSnapshot()
        return
      }
      await this.opts.sendKeys(handle, { text: 'continue', enter: true })
    } catch (error) {
      this.logger.warn('[auto-resume] sendKeys failed', { ptyId, error })
      this.giveUp(stall, 'send-failed')
      return
    }
    // Banner: confirm the resend actually resumed the agent.
    stall.resumesAt = this.now() + POST_SEND_VERIFY_MS
    stall.phase = 'acting'
    stall.timer = this.schedule(() => {
      void this.onPostSendVerify(ptyId)
    }, POST_SEND_VERIFY_MS)
    this.emitSnapshot()
  }

  private async onPostSendVerify(ptyId: string): Promise<void> {
    const stall = this.tracked.get(ptyId)
    if (!stall) {
      return
    }
    stall.timer = null
    const snapshot = this.opts.verifyStall(ptyId)
    if (!snapshot || !snapshot.present || snapshot.agentWorking) {
      // Recovered — the resend worked (or the agent moved on).
      this.tracked.delete(ptyId)
      this.emitSnapshot()
      return
    }
    if (stall.attempts >= MAX_RESUME_ATTEMPTS) {
      this.giveUp(stall, 'max-attempts')
      return
    }
    // Still stalled and attempts remain — resend once more immediately.
    void this.onActionDue(ptyId)
  }

  private giveUp(stall: TrackedStall, reason: string): void {
    this.logger.debug('[auto-resume] giving up', { ptyId: stall.ptyId, reason })
    this.clearTimer(stall)
    this.tracked.delete(stall.ptyId)
    this.opts.notify?.({
      kind: 'failed',
      worktreeId: stall.worktreeId,
      paneKey: stall.paneKey,
      provider: stall.provider,
      reason: stall.reason,
      resumesAt: null
    })
    this.emitSnapshot()
  }

  private schedule(fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, delayMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return timer
  }

  private clearTimer(stall: TrackedStall): void {
    if (stall.timer) {
      clearTimeout(stall.timer)
      stall.timer = null
    }
  }

  private emitSnapshot(): void {
    this.opts.onSnapshot?.(this.getSnapshot())
  }

  getSnapshot(): AgentAutoResumeSnapshot {
    const entries: AgentAutoResumeEntry[] = [...this.tracked.values()].map((stall) => ({
      ptyId: stall.ptyId,
      worktreeId: stall.worktreeId,
      paneKey: stall.paneKey,
      provider: stall.provider,
      reason: stall.reason,
      resumesAt: stall.resumesAt,
      detectedAt: stall.detectedAt,
      phase: stall.phase
    }))
    return { enabled: this.enabled, entries }
  }
}
