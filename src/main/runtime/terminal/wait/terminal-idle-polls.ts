import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { isPagerProcess } from '../../../../shared/agent-status/process/pager-process-detection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { evaluateTuiIdle, type QuietForegroundLane, type TuiIdleVerdict } from './tui-idle-evidence'
import {
  outputClockOf,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from './tui-idle-evidence-source'

/** Open lanes accept missing clocks as uncorroborated quiet for unseen daemon output; caller timeouts remain and delivery cannot use this lane.
 * Known agents on after-paint lanes must first paint their own command output, excluding shell prompts/echo. */
function isQuietForQuiescence(
  lastOutputAt: number | null,
  quiescenceMs: number,
  lane: QuietForegroundLane,
  commandPainted: () => boolean
): boolean {
  if (lane === 'after-paint' && !commandPainted()) {
    return false
  }
  if (lastOutputAt === null) {
    return lane === 'open'
  }
  return Date.now() - lastOutputAt >= quiescenceMs
}
import type { TerminalWaiter } from './terminal-waiter'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

type RuntimeTerminalIdlePollDependencies = TuiIdleEvidenceSource & {
  intervalMs: number
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  /** Whether the pane's running command has painted anything of its own. */
  hasCommandPainted(ptyId: string): boolean
  /** The pane's rendered viewport, or null when the runtime holds no screen model for it. */
  readVisibleScreen(ptyId: string): Promise<string | null> | null
  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
}

type IdlePollEntry = {
  waiter: TerminalWaiter
  pty: RuntimePtyWorktreeRecord
  foregroundPollInFlight: boolean
  screenReadInFlight: boolean
  recheckTimer?: ReturnType<typeof setTimeout>
}

/** One reading of a waiter's pane, and the results it would settle with. */
type IdlePollSample = {
  verdict: TuiIdleVerdict
  ptyId: string
  ready(): RuntimeTerminalWait
  blocked(reason: RuntimeTerminalWaitBlockedReason): RuntimeTerminalWait
  isQuiet(lane: QuietForegroundLane): boolean
}

/** A foreground read pinned to the quiet stretch it was taken in; output moving on retires it. */
type QuietForegroundRead = {
  pty: RuntimePtyWorktreeRecord
  process: string | null
  outputClockAt: number | null
}

export class RuntimeTerminalIdlePolls {
  private readonly entries = new Set<IdlePollEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly quietForegroundByPtyId = new Map<string, QuietForegroundRead>()
  /** The evidence source the polls evaluate with: the shared one plus this poll's own foreground reads. */
  private readonly evidenceSource: TuiIdleEvidenceSource

  constructor(private readonly deps: RuntimeTerminalIdlePollDependencies) {
    this.evidenceSource = {
      ...deps,
      getQuietForegroundProcess: (ptyId) => this.quietForegroundProcessOf(ptyId)
    }
  }

  private quietForegroundProcessOf(ptyId: string | null | undefined): string | null {
    const read = ptyId ? this.quietForegroundByPtyId.get(ptyId) : undefined
    return read && outputClockOf(this.deps, read.pty) === read.outputClockAt ? read.process : null
  }

  /** `verdict` is what the caller just evaluated; weak ready is checked at once, not a sweep later. */
  start(waiter: TerminalWaiter, pty: RuntimePtyWorktreeRecord, verdict?: TuiIdleVerdict): void {
    const entry = { waiter, pty, foregroundPollInFlight: false, screenReadInFlight: false }
    this.entries.add(entry)
    entry.waiter.cancelIdlePoll = () => this.stop(entry)
    // Share one sweep timer so idle main wakeups do not scale with waiter count.
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.deps.intervalMs)
    }
    // Probe weak ready immediately; short automation waits may expire before the next sweep.
    if (verdict?.kind === 'ready-weak') {
      void this.tick(entry)
    } else if (verdict) {
      this.armRecheck(entry, verdict)
    }
  }

  /** Test/diagnostic seam: live sweep handles, which must stay at most one. */
  get activeTimerCount(): number {
    return this.sweepTimer ? 1 : 0
  }

  private armRecheck(entry: IdlePollEntry, verdict: TuiIdleVerdict): void {
    if (verdict.kind !== 'pending' || verdict.recheckAt === undefined || entry.recheckTimer) {
      return
    }
    entry.recheckTimer = setTimeout(
      () => {
        entry.recheckTimer = undefined
        void this.tick(entry)
      },
      Math.max(verdict.recheckAt - Date.now(), 0)
    )
  }

  private sweep(): void {
    // Snapshot and run independently without awaiting: slow process reads cannot delay peers, and newly registered waits start next tick.
    for (const entry of Array.from(this.entries)) {
      void this.tick(entry)
    }
  }

  private sample(entry: IdlePollEntry): IdlePollSample {
    const { handle } = entry.waiter
    // PTY records mutate in place, so this captured reference remains live.
    const { pty } = entry
    const readWaitText = () =>
      buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    return {
      verdict: evaluateTuiIdle({
        ...ptyTuiIdleEvidence(this.evidenceSource, pty, readWaitText),
        launchReadiness: entry.waiter.launchReadiness
      }),
      ptyId: pty.ptyId,
      ready: () => buildPtyTerminalWaitResult(handle, 'tui-idle', pty),
      blocked: (reason) => buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, reason),
      isQuiet: (lane) =>
        isQuietForQuiescence(outputClockOf(this.deps, pty), this.deps.quiescenceMs, lane, () =>
          this.deps.hasCommandPainted(pty.ptyId)
        )
    }
  }

  private async tick(entry: IdlePollEntry): Promise<void> {
    if (!this.entries.has(entry)) {
      return
    }
    let startedForegroundPoll = false
    try {
      const sample = this.sample(entry)
      const { verdict, ptyId } = sample
      if (verdict.kind === 'blocked') {
        this.settle(entry, sample.blocked(verdict.reason))
        return
      }
      // Strong readiness outranks unscoped dialog wording elsewhere on the screen.
      if (verdict.kind === 'ready-strong') {
        this.settle(entry, sample.ready())
        return
      }
      this.armRecheck(entry, verdict)
      // Working output can quote dialog source; do not screen-probe it for startup blockers.
      if (verdict.kind === 'working' || entry.screenReadInFlight) {
        return
      }
      const screenRead = this.readScreenBlockedReason(entry, ptyId)
      // Why await only a real read: a pane with no screen model keeps its tick synchronous.
      const screenBlockedReason = screenRead ? await screenRead : null
      if (!this.entries.has(entry)) {
        return
      }
      if (screenBlockedReason) {
        this.settle(entry, sample.blocked(screenBlockedReason))
        return
      }
      if (verdict.kind === 'ready-weak') {
        this.settle(entry, sample.ready())
        return
      }
      const lane = verdict.quietForeground
      if (lane === 'closed') {
        await this.readTitleOnlyQuietForeground(entry, sample)
        return
      }
      // Why quiet before the read too: a streaming or not-yet-painted pane cannot settle, so it
      // must not pay a process inspection every tick for a whole turn.
      if (!entry.foregroundPollInFlight && sample.isQuiet(lane)) {
        const foregroundRead = this.deps.getForegroundProcess(ptyId)
        if (!foregroundRead) {
          return
        }
        entry.foregroundPollInFlight = true
        startedForegroundPoll = true
        const foreground = await foregroundRead
        if (foreground && !isShellProcess(foreground) && sample.isQuiet(lane)) {
          this.settle(entry, sample.ready())
        }
      }
    } catch {
      // Transient process inspection errors do not retire the waiter.
    } finally {
      if (startedForegroundPoll) {
        entry.foregroundPollInFlight = false
      }
    }
  }

  /** A closed lane normally settles on evidence alone. A pane identified only by its retained
   *  title (no launch, foreground or command authority) may be holding for a composer the live
   *  process never draws: `claude --help | less` leaves Claude's name over a pager. Read the quiet
   *  foreground once per quiet stretch; when it is a known non-agent, the paint gate reads it on the
   *  re-sample and the any-byte rule decides. Launched or foreground-recognized agents never pay
   *  this read (STA-14925). */
  private async readTitleOnlyQuietForeground(
    entry: IdlePollEntry,
    sample: IdlePollSample
  ): Promise<void> {
    const { ptyId } = sample
    if (
      entry.foregroundPollInFlight ||
      this.deps.getPaneAgent(ptyId) !== null ||
      !sample.isQuiet('closed')
    ) {
      return
    }
    const outputClockAt = outputClockOf(this.deps, entry.pty)
    if (this.quietForegroundByPtyId.get(ptyId)?.outputClockAt === outputClockAt) {
      return
    }
    const foregroundRead = this.deps.getForegroundProcess(ptyId)
    if (!foregroundRead) {
      return
    }
    entry.foregroundPollInFlight = true
    try {
      const process = await foregroundRead
      if (!this.entries.has(entry)) {
        return
      }
      // Why not a failed read: it says nothing about the foreground, and keeping it for the quiet
      // stretch would stop the pager check until output moved again. The next sweep reads again.
      if (process === null) {
        return
      }
      this.quietForegroundByPtyId.set(ptyId, { pty: entry.pty, process, outputClockAt })
      if (isPagerProcess(process)) {
        const resample = this.sample(entry)
        if (resample.verdict.kind === 'ready-weak' && resample.isQuiet('closed')) {
          this.settle(entry, resample.ready())
        }
      }
    } finally {
      entry.foregroundPollInFlight = false
    }
  }

  /** Why the screen too: a dialog that parks the cursor above its own options (Claude's
   *  workspace trust) loses those rows from the line tail; the rendered screen still has them. */
  private readScreenBlockedReason(
    entry: IdlePollEntry,
    ptyId: string
  ): Promise<RuntimeTerminalWaitBlockedReason | null> | null {
    const screenRead = this.deps.readVisibleScreen(ptyId)
    if (!screenRead) {
      return null
    }
    entry.screenReadInFlight = true
    return screenRead
      .then((screen) => (screen ? detectTerminalWaitBlockedReason(screen) : null))
      .finally(() => {
        entry.screenReadInFlight = false
      })
  }

  private settle(entry: IdlePollEntry, result: RuntimeTerminalWait): void {
    this.stop(entry)
    this.deps.resolve(entry.waiter, result)
  }

  private stop(entry: IdlePollEntry): void {
    if (!this.entries.delete(entry)) {
      return
    }
    this.quietForegroundByPtyId.delete(entry.pty.ptyId)
    entry.waiter.cancelIdlePoll = null
    clearTimeout(entry.recheckTimer)
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
