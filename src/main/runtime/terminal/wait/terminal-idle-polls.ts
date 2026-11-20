import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { settlesForMidTurnInput } from './terminal-delivery-refusal'
import { evaluateTuiIdle, type QuietForegroundLane, type TuiIdleVerdict } from './tui-idle-evidence'
import {
  outputClockOf,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from './tui-idle-evidence-source'

import { isQuietForQuiescence } from './quiet-foreground-quiescence'
import { ReattachedRestTitleReads } from './reattached-rest-title'

import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalWaiter } from './terminal-waiter'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

/** A foreground read that proved nothing is retried after this, while the pane stays quiet. */
const FAILED_FOREGROUND_RETRY_MS = 10_000

type RuntimeTerminalIdlePollDependencies = TuiIdleEvidenceSource & {
  intervalMs: number
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  /** Whether the pane's running command has painted anything of its own. */
  hasCommandPainted(ptyId: string): boolean
  /** The pane's rendered viewport, or null when the runtime holds no screen model for it. */
  readVisibleScreen(ptyId: string): Promise<string | null> | null
  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
  /** Asks a reattached pane's program to repaint, once per reattach and only before it painted. */
  requestReattachedRepaint?(ptyId: string): void
  /** True once a fresh read put the rest title's own agent in front and its idle was admitted. */
  confirmRestTitle?(ptyId: string, agent: TuiAgent): Promise<boolean>
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
  /** A mid-turn agent that takes input settles a waiter that accepts it. */
  takesInputNow: boolean
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
  /** When the read began; a failed (null) read is retried only after the retry interval. */
  readAt: number
  /** Still awaiting its answer; every wait on the pane shares it rather than reading again. */
  pending: boolean
}

export class RuntimeTerminalIdlePolls {
  private readonly entries = new Set<IdlePollEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly quietForegroundByPtyId = new Map<string, QuietForegroundRead>()
  /** Pending waits per pane: pane-shared read state lives until the last of them ends. */
  private readonly entriesByPtyId = new Map<string, Set<IdlePollEntry>>()
  private readonly restTitleReads: ReattachedRestTitleReads<RuntimePtyWorktreeRecord>
  /** The evidence source the polls evaluate with: the shared one plus this poll's own foreground reads. */
  private readonly evidenceSource: TuiIdleEvidenceSource

  constructor(private readonly deps: RuntimeTerminalIdlePollDependencies) {
    this.evidenceSource = {
      ...deps,
      getQuietForegroundProcess: (ptyId) => this.quietForegroundProcessOf(ptyId)
    }
    this.restTitleReads = new ReattachedRestTitleReads(
      (pty) => outputClockOf(deps, pty),
      deps.confirmRestTitle
    )
  }

  private quietForegroundProcessOf(ptyId: string | null | undefined): string | null {
    const read = ptyId ? this.quietForegroundByPtyId.get(ptyId) : undefined
    return read && outputClockOf(this.deps, read.pty) === read.outputClockAt ? read.process : null
  }

  /** `verdict` is what the caller just evaluated; weak ready is checked at once, not a sweep later. */
  start(waiter: TerminalWaiter, pty: RuntimePtyWorktreeRecord, verdict?: TuiIdleVerdict): void {
    const entry = { waiter, pty, foregroundPollInFlight: false, screenReadInFlight: false }
    this.entries.add(entry)
    const paneEntries = this.entriesByPtyId.get(pty.ptyId) ?? new Set<IdlePollEntry>()
    paneEntries.add(entry)
    this.entriesByPtyId.set(pty.ptyId, paneEntries)
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
    const evidence = ptyTuiIdleEvidence(this.evidenceSource, pty, readWaitText)
    const verdict = evaluateTuiIdle({ ...evidence, launchReadiness: entry.waiter.launchReadiness })
    return {
      verdict,
      takesInputNow:
        !!entry.waiter.acceptsMidTurnInput && settlesForMidTurnInput(verdict, pty.ptyId, this.deps),
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
      if (verdict.kind === 'ready-strong' || sample.takesInputNow) {
        this.settle(entry, sample.ready())
        return
      }
      this.armRecheck(entry, verdict)
      // Why from the wait, working included: a reattached pane's restored status or screen counts
      // only once its program repaints it.
      if (ptyId) {
        this.deps.requestReattachedRepaint?.(ptyId)
      }
      if (verdict.kind === 'working') {
        return
      }
      // Working output can quote dialog source; do not screen-probe it for startup blockers.
      if (entry.screenReadInFlight) {
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
      const restTitleRead = this.readRestTitleForeground(entry, sample)
      if (restTitleRead) {
        await restTitleRead
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
    // Why paint first: before the command paints anything, no foreground answer can make it ready.
    // Why idle only: the answer feeds the paint gate, which cannot turn a permission or working title ready.
    if (
      (entry.pty.lastAgentStatus ?? 'idle') !== 'idle' ||
      entry.foregroundPollInFlight ||
      this.deps.getPaneAgent(ptyId) !== null ||
      !sample.isQuiet('closed') ||
      !this.deps.hasCommandPainted(ptyId)
    ) {
      return
    }
    const outputClockAt = outputClockOf(this.deps, entry.pty)
    const last = this.quietForegroundByPtyId.get(ptyId)
    // Why per pane: every wait on it shares one read in flight and its answer for the quiet
    // stretch; a failed read says nothing, so it is retried after the interval, not every sweep.
    if (
      last?.outputClockAt === outputClockAt &&
      (last.pending ||
        last.process !== null ||
        Date.now() - last.readAt < FAILED_FOREGROUND_RETRY_MS)
    ) {
      return
    }
    const foregroundRead = this.deps.getForegroundProcess(ptyId)
    if (!foregroundRead) {
      return
    }
    const read = { pty: entry.pty, process: null, outputClockAt, readAt: Date.now(), pending: true }
    this.quietForegroundByPtyId.set(ptyId, read)
    entry.foregroundPollInFlight = true
    try {
      // Why kept when this wait ended: the pane's other waits read the answer from the cache.
      const process = await foregroundRead.catch(() => null)
      if (this.quietForegroundByPtyId.get(ptyId) !== read) {
        return
      }
      this.quietForegroundByPtyId.set(ptyId, { ...read, process, pending: false })
      // Why a tick now, not settling here: the weak-ready path reads the cached answer and checks
      // the rendered screen for a blocker first; waiting for the next sweep could outlast a short wait.
      // Every wait on the pane, not only the one that asked: that one may have ended meanwhile.
      if (process !== null) {
        for (const peer of this.entriesByPtyId.get(ptyId) ?? []) {
          queueMicrotask(() => void this.tick(peer))
        }
      }
    } finally {
      entry.foregroundPollInFlight = false
    }
  }

  /** A reattached quiet agent's masked rest title, asked about only for a pending wait. */
  private readRestTitleForeground(
    entry: IdlePollEntry,
    sample: IdlePollSample
  ): Promise<void> | null {
    const read = sample.isQuiet('closed') ? this.restTitleReads.confirm(entry.pty) : null
    return read
      ? read.then((confirmed) => {
          const resample = confirmed && this.entries.has(entry) ? this.sample(entry) : null
          if (resample?.verdict.kind === 'ready-strong') {
            this.settle(entry, resample.ready())
          }
        })
      : null
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
    const { ptyId } = entry.pty
    const paneEntries = this.entriesByPtyId.get(ptyId)
    paneEntries?.delete(entry)
    if (!paneEntries?.size) {
      this.entriesByPtyId.delete(ptyId)
      this.quietForegroundByPtyId.delete(ptyId)
      this.restTitleReads.forget(ptyId)
    }
    entry.waiter.cancelIdlePoll = null
    clearTimeout(entry.recheckTimer)
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
