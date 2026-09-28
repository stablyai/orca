import { isShellProcess } from '../../shared/agent-detection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  evaluateTuiIdle,
  leafTuiIdleEvidence,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource,
  type TuiIdleVerdict
} from './tui-idle-evidence'

/**
 * Why null counts as quiet: a record with no output timestamp has produced nothing the
 * RUNTIME OBSERVED since it was created. That is not the same as silence — the reachable
 * case is a daemon-hosted pane whose bytes never reach the runtime, which may still be
 * streaming. The trade is deliberate: "never settles" becomes "settles uncorroborated",
 * the caller keeps its timeout, and delivery cannot reach this lane. Reading it as `0ms since output`
 * inverted that — `0 >= quiescenceMs` is false forever, so an adopted pane that never
 * emitted could not settle no matter how long the caller waited.
 */
function isQuietForQuiescence(lastOutputAt: number | null, quiescenceMs: number): boolean {
  return lastOutputAt === null ? true : Date.now() - lastOutputAt >= quiescenceMs
}
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type RuntimeTerminalIdlePollDependencies = TuiIdleEvidenceSource & {
  intervalMs: number
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  /** The pane's rendered viewport, or null when the runtime holds no screen model for it. */
  readVisibleScreen(ptyId: string): Promise<string | null> | null
  /** Re-read the record the waiter registered against; see `sample` below. */
  getLiveLeaf(leaf: RuntimeLeafRecord): RuntimeLeafRecord
  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
}

type IdlePollEntry = {
  waiter: TerminalWaiter
  foregroundPollInFlight: boolean
  screenReadInFlight: boolean
} & ({ kind: 'leaf'; leaf: RuntimeLeafRecord } | { kind: 'pty'; pty: RuntimePtyWorktreeRecord })

/** One reading of a waiter's pane, and the results it would settle with. */
type IdlePollSample = {
  verdict: TuiIdleVerdict
  ptyId: string | null
  ready(): RuntimeTerminalWait
  blocked(reason: RuntimeTerminalWaitBlockedReason): RuntimeTerminalWait
  isQuiet(): boolean
}

const IDLE_ENTRY_FLAGS = { foregroundPollInFlight: false, screenReadInFlight: false }

export class RuntimeTerminalIdlePolls {
  private readonly entries = new Set<IdlePollEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: RuntimeTerminalIdlePollDependencies) {}

  /** `verdict` is what the caller just evaluated; weak ready is checked at once, not a sweep later. */
  startLeaf(waiter: TerminalWaiter, leaf: RuntimeLeafRecord, verdict?: TuiIdleVerdict): void {
    this.start({ kind: 'leaf', waiter, leaf, ...IDLE_ENTRY_FLAGS }, verdict)
  }

  startPty(waiter: TerminalWaiter, pty: RuntimePtyWorktreeRecord, verdict?: TuiIdleVerdict): void {
    this.start({ kind: 'pty', waiter, pty, ...IDLE_ENTRY_FLAGS }, verdict)
  }

  /** Test/diagnostic seam: live sweep handles, which must stay at most one. */
  get activeTimerCount(): number {
    return this.sweepTimer ? 1 : 0
  }

  private start(entry: IdlePollEntry, verdict: TuiIdleVerdict | undefined): void {
    this.entries.add(entry)
    entry.waiter.cancelIdlePoll = () => this.stop(entry)
    // Why one shared timer for every waiter: a per-waiter interval multiplied idle
    // main-process wakeups by the number of concurrent `wait` calls, independent of
    // whether any terminal produced output. Same shape as the synthetic-title spinner.
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.deps.intervalMs)
    }
    // Why: the evidence is already in hand and only needs its screen read; a probe that
    // times out under one interval (the automation start probe) would otherwise never see it.
    if (verdict?.kind === 'ready-weak') {
      void this.tick(entry)
    }
  }

  private sweep(): void {
    // Why a snapshot and no await: each entry must run its checks and then interleave
    // its own foreground read exactly as an independent interval callback did — one
    // slow `ps` must never delay another waiter's checks, and a waiter registered by a
    // resolve inside this sweep must wait for the next tick, as a fresh interval would.
    for (const entry of Array.from(this.entries)) {
      void this.tick(entry)
    }
  }

  private sample(entry: IdlePollEntry): IdlePollSample {
    const { handle } = entry.waiter
    if (entry.kind === 'pty') {
      // Why no re-read here: `ptysById` has a single create-once `set` site, so PTY
      // records are mutated in place rather than swapped, and a capture stays live.
      const { pty } = entry
      const readWaitText = () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      return {
        verdict: evaluateTuiIdle(ptyTuiIdleEvidence(this.deps, pty, readWaitText)),
        ptyId: pty.ptyId,
        ready: () => buildPtyTerminalWaitResult(handle, 'tui-idle', pty),
        blocked: (reason) => buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, reason),
        isQuiet: () => isQuietForQuiescence(pty.lastOutputAt, this.deps.quiescenceMs)
      }
    }
    // Why re-read: `syncWindowGraph` rebuilds `this.leaves` with fresh objects on every
    // renderer publish, so the record captured at registration stops advancing. Its
    // `lastOutputAt` freezes, the quiescence gate then reads an ever-growing elapsed
    // time, and the waiter settles while the pane is in fact still streaming.
    const leaf = this.deps.getLiveLeaf(entry.leaf)
    const readWaitText = () =>
      buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    const live = () => this.deps.getLiveLeaf(entry.leaf)
    return {
      verdict: evaluateTuiIdle(leafTuiIdleEvidence(this.deps, leaf, readWaitText)),
      ptyId: leaf.ptyId,
      ready: () => buildTerminalWaitResult(handle, 'tui-idle', live()),
      blocked: (reason) => buildTerminalWaitBlockedResult(handle, 'tui-idle', live(), reason),
      isQuiet: () => isQuietForQuiescence(live().lastOutputAt, this.deps.quiescenceMs)
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
      // Why strong ready outranks the screen: the detector is not scoped to a region, so dialog
      // wording anywhere on a finished agent's screen would otherwise read as blocked.
      if (verdict.kind === 'ready-strong') {
        this.settle(entry, sample.ready())
        return
      }
      // Why no screen read while working: its output can quote dialog wording (a diff of this
      // detector), and the dialogs only the screen shows are start-up ones, painted before any title.
      if (verdict.kind === 'working' || entry.screenReadInFlight) {
        return
      }
      const screenRead = ptyId ? this.readScreenBlockedReason(entry, ptyId) : null
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
      if (verdict.quietForeground && ptyId && !entry.foregroundPollInFlight) {
        const foregroundRead = this.deps.getForegroundProcess(ptyId)
        if (!foregroundRead) {
          return
        }
        entry.foregroundPollInFlight = true
        startedForegroundPoll = true
        const foreground = await foregroundRead
        if (foreground && !isShellProcess(foreground) && sample.isQuiet()) {
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
    entry.waiter.cancelIdlePoll = null
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
