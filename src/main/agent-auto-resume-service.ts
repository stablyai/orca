import type {
  AgentAutoResumeEntry,
  AgentAutoResumeSnapshot
} from '../shared/agent-auto-resume-types'
import type { UsageLimitStallEvent } from './runtime/orca-runtime'
import {
  computeBannerResumeAt,
  INDETERMINATE_RETRY_DELAY_MS,
  MAX_INDETERMINATE_RETRIES,
  MAX_RESUME_ATTEMPTS,
  POST_SEND_VERIFY_MS,
  type AgentAutoResumeServiceOptions,
  type TrackedStall
} from './agent-auto-resume-contracts'

export * from './agent-auto-resume-contracts'

/**
 * Watches for usage-limit stall events (from the runtime's live PTY scan) and,
 * for terminals the user ticked "Rate limit watcher" on, auto-resumes the
 * agent:
 *
 *  - `usage-limit-menu`: wait the user's configured idle timeout so a human can
 *    intervene, then — if the menu is still live — move the highlight onto "Stop
 *    and wait for limit to reset" by label and confirm it. The CLI then owns its
 *    own countdown/resume.
 *  - `usage-limit-banner`: arm a timer for max(banner resetsAt, provider
 *    resetsAt) + grace, re-verify the banner is still on screen, then resend
 *    "continue". Retry once more on failure, then give up and notify.
 *  - `usage-limit-reset-prompt`: the limit is already over and the CLI wants one
 *    keypress. Wait the same human-first grace, then send Enter and nothing else.
 *  - `usage-limit-cli-waiting`: the CLI is resuming itself; stand down entirely.
 *  - PTY exit while limited: notify (the dead-PTY path is handed to the
 *    renderer's sleeping-agent resume flow on worktree activation).
 *
 * Every action is gated on a fresh re-verification against the live tail — the
 * service never acts on stale content and never pokes a working agent.
 */
export class AgentAutoResumeService {
  private readonly tracked = new Map<string, TrackedStall>()
  private readonly opts: AgentAutoResumeServiceOptions
  private readonly now: () => number
  private readonly logger: Pick<Console, 'debug' | 'warn'>

  constructor(options: AgentAutoResumeServiceOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
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
    // Claude Code 2.1.234+ waits out the limit in-session and resumes itself.
    // Stand down — and drop any wait armed off the plain banner that preceded
    // the countdown, or both of us would resume the same turn. The runtime keeps
    // the record, so a scheduled message still defers while the CLI waits.
    if (event.reason === 'usage-limit-cli-waiting') {
      this.onCleared(event.ptyId)
      return
    }
    if (!this.opts.isWatchEnabled(event.paneKey)) {
      return
    }
    const existing = this.tracked.get(event.ptyId)
    // Dedup: an active wait for the same stall must not re-arm on redraw churn.
    // Only a changed reason re-arms — a resolved stall is already gone from the
    // map, so presence here always means the wait is still live.
    if (existing?.reason === event.reason) {
      existing.handle = event.handle
      // A later banner can carry a corrected, further-out reset; keeping the first resends early.
      // Record it on any real change, so redraw churn still costs nothing.
      if (existing.reason === 'usage-limit-banner' && event.resetsAt !== existing.resetsAt) {
        existing.resetsAt = event.resetsAt
        // Mid-action entries own their own schedule; the post-send verify honours a correction.
        if (existing.phase === 'waiting') {
          this.clearTimer(existing)
          this.armActionTimer(existing)
        }
        this.emitSnapshot()
      }
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
      indeterminateReads: 0,
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
    // The banner is the only reason with a reset to wait for. A chooser and the
    // CLI's own "press enter to continue" are both already-on-screen prompts, so
    // the only wait they need is the human-first grace.
    const resumesAt =
      stall.reason === 'usage-limit-banner'
        ? computeBannerResumeAt(stall, this.opts.getProviderResetAt?.(stall.provider) ?? null, now)
        : now + Math.max(0, this.opts.getMenuGraceMs())
    stall.resumesAt = resumesAt
    stall.phase = 'waiting'
    const delay = Math.max(0, resumesAt - now)
    stall.timer = this.schedule(() => {
      void this.onActionDue(stall.ptyId)
    }, delay)
  }

  private async onActionDue(ptyId: string): Promise<void> {
    const stall = this.tracked.get(ptyId)
    if (!stall) {
      return
    }
    stall.timer = null
    stall.phase = 'acting'
    // Why re-check the opt-in here and not only at detection: a grace/reset wait
    // can run for hours, and the user may have unticked "Rate limit watcher" in
    // the meantime. No keystroke may ever reach a terminal that is no longer
    // marked, so the flag is read again immediately before acting.
    if (!this.opts.isWatchEnabled(stall.paneKey)) {
      this.tracked.delete(ptyId)
      this.emitSnapshot()
      return
    }
    const snapshot = this.opts.verifyStall(ptyId)
    // Product rule #6: never act on stale data. `actionable` is false unless the
    // stall is confirmed live on screen right now — for a menu that means a
    // readable chooser still owns the bottom of the tail, since its text lingers
    // in the retained tail long after it is dismissed. Anything else is either
    // recovery — stop quietly — or a screen we cannot read, which is re-read
    // below rather than treated as either.
    //
    // `agentWorking` vetoes banners only. A banner prints after the turn ends,
    // so a working title really does mean the agent moved on. The chooser
    // interrupts a turn WITHOUT ending it, and the title keeps the interrupted
    // turn's spinner for as long as the menu sits there — on 2026-08-27 that
    // spinner made a four-hour menu stall read as "recovered" and the watcher
    // dropped it without acting. For menus the screen is the truth, and
    // chooseMenuReset re-reads it by label before any key is pressed.
    if (!snapshot || (snapshot.agentWorking && stall.reason !== 'usage-limit-menu')) {
      this.tracked.delete(ptyId)
      this.emitSnapshot()
      return
    }
    if (!snapshot.actionable) {
      // One exception to "stop quietly": a frame the chooser parser could not
      // classify proves nothing either way, and the pane it describes emits no
      // further output — so dropping the entry here would park the agent for the
      // whole limit window. Re-read on a cadence, and only give up (loudly) once
      // the screen has stayed unreadable across the whole retry budget.
      if (!snapshot.indeterminate) {
        this.tracked.delete(ptyId)
        this.emitSnapshot()
        return
      }
      if (stall.indeterminateReads >= MAX_INDETERMINATE_RETRIES) {
        this.giveUp(stall, 'menu-unreadable')
        return
      }
      stall.indeterminateReads += 1
      stall.phase = 'waiting'
      stall.resumesAt = this.now() + INDETERMINATE_RETRY_DELAY_MS
      stall.timer = this.schedule(() => {
        void this.onActionDue(ptyId)
      }, INDETERMINATE_RETRY_DELAY_MS)
      this.emitSnapshot()
      return
    }
    const handle = snapshot.handle ?? stall.handle
    stall.attempts += 1
    try {
      if (stall.reason === 'usage-limit-menu') {
        if (!(await this.opts.chooseMenuReset(ptyId, handle, snapshot.waitText))) {
          this.giveUp(stall, 'menu-unreadable')
          return
        }
        if (this.isStillTracked(ptyId, stall)) {
          this.tracked.delete(ptyId)
          this.emitSnapshot()
        }
        return
      }
      // Enter alone for the CLI's own reset prompt: it is asking for a keypress,
      // not a message, and any text would be swallowed or land in the prompt it
      // reopens. The banner path has no prompt to answer, so it resends.
      await this.opts.sendKeys(
        handle,
        stall.reason === 'usage-limit-reset-prompt'
          ? { enter: true }
          : { text: 'continue', enter: true }
      )
    } catch (error) {
      this.logger.warn('[auto-resume] sendKeys failed', { ptyId, error })
      this.giveUp(stall, 'send-failed')
      return
    }
    if (!this.isStillTracked(ptyId, stall)) {
      // A newer stall (or a clear/exit) took over this PTY while the send was in
      // flight. That entry owns the schedule now; arming a timer on this orphan
      // would fire a second resend ahead of the live entry's own deadline.
      return
    }
    // Banner: confirm the resend actually resumed the agent.
    stall.resumesAt = this.now() + POST_SEND_VERIFY_MS
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
    if (!snapshot || !snapshot.actionable || snapshot.agentWorking) {
      // Recovered — the resend worked (or the agent moved on).
      this.tracked.delete(ptyId)
      this.emitSnapshot()
      return
    }
    if (stall.attempts >= MAX_RESUME_ATTEMPTS) {
      this.giveUp(stall, 'max-attempts')
      return
    }
    // A reset now in the future means we typed early; wait the corrected reset out
    // instead of spending the last attempt just as early.
    const resetsAt = Math.max(
      stall.resetsAt ?? 0,
      this.opts.getProviderResetAt?.(stall.provider) ?? 0
    )
    if (stall.reason === 'usage-limit-banner' && resetsAt > this.now()) {
      this.armActionTimer(stall)
      this.emitSnapshot()
      return
    }
    // Still stalled and attempts remain — resend once more immediately.
    void this.onActionDue(ptyId)
  }

  private giveUp(stall: TrackedStall, reason: string): void {
    this.logger.debug('[auto-resume] giving up', { ptyId: stall.ptyId, reason })
    this.clearTimer(stall)
    // Both menu give-ups are reached after an await, so a newer stall may already
    // own this ptyId. Deleting by key would take that live entry's schedule down
    // with this dead one and notify the user about a stall that was superseded.
    if (!this.isStillTracked(stall.ptyId, stall)) {
      return
    }
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

  /** Every `sendKeys` await yields, and a detected/cleared/exited event can
   *  replace or remove this ptyId's entry meanwhile. Identity — not presence —
   *  is the test: a same-key replacement is a different stall. */
  private isStillTracked(ptyId: string, stall: TrackedStall): boolean {
    return this.tracked.get(ptyId) === stall
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
    return { entries }
  }
}
