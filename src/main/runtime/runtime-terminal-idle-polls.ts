import { isShellProcess } from '../../shared/agent-detection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { readsTrustedScreen } from './agent-state-rules/agent-state-rules-engine'
import {
  RuntimeTerminalProviderScreen,
  type ProviderScreenDependencies,
  type TuiIdleProviderScreen
} from './runtime-terminal-provider-screen'
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
import {
  canReadQuietProvider,
  isCurrentIdleSample,
  isQuietForQuiescence,
  needsProviderScreen,
  type IdlePollSample
} from './runtime-terminal-idle-sample'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type RuntimeTerminalIdlePollDependencies = TuiIdleEvidenceSource &
  ProviderScreenDependencies & {
    intervalMs: number
    getForegroundProcess(ptyId: string): Promise<string | null> | null
    /** Whether the pane's running command has painted anything of its own. */
    hasCommandPainted(ptyId: string): boolean
    /** The pane's rendered viewport, or null when the runtime holds no screen model for it. */
    readVisibleScreen(ptyId: string): Promise<string | null> | null
    /** Re-read the record the waiter registered against; see `sample` below. */
    getLiveLeaf(leaf: RuntimeLeafRecord): RuntimeLeafRecord
    resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
  }

type IdlePollRegistration = {
  waiter: TerminalWaiter
  foregroundPollInFlight: boolean
  screenReadInFlight: boolean
} & ({ kind: 'leaf'; leaf: RuntimeLeafRecord } | { kind: 'pty'; pty: RuntimePtyWorktreeRecord })

type IdlePollEntry = IdlePollRegistration & { providerScreen: RuntimeTerminalProviderScreen }

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

  private start(initial: IdlePollRegistration, verdict: TuiIdleVerdict | undefined): void {
    const entry: IdlePollEntry = {
      ...initial,
      providerScreen: new RuntimeTerminalProviderScreen(
        this.deps,
        initial.kind === 'pty' ? initial.pty.ptyId : initial.leaf.ptyId
      )
    }
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

  private sample(entry: IdlePollEntry, screen?: TuiIdleProviderScreen): IdlePollSample {
    const { handle } = entry.waiter
    const currentVersion = entry.providerScreen.captureVersion()
    const isCurrent = () => currentVersion() && (!screen || screen.isCurrent())
    const source: TuiIdleEvidenceSource = screen
      ? {
          ...this.deps,
          readScreenLines: () => screen.lines,
          readScreenRuledLines: () => screen.lines
        }
      : this.deps
    if (entry.kind === 'pty') {
      // Why no re-read here: `ptysById` has a single create-once `set` site, so PTY
      // records are mutated in place rather than swapped, and a capture stays live.
      const { pty } = entry
      const readWaitText = () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      return {
        verdict: evaluateTuiIdle(ptyTuiIdleEvidence(source, pty, readWaitText)),
        providerEligible: canReadQuietProvider(pty),
        isCurrent,
        ptyId: pty.ptyId,
        ready: () => buildPtyTerminalWaitResult(handle, 'tui-idle', pty),
        blocked: (reason) => buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, reason),
        isQuiet: (lane) =>
          isQuietForQuiescence(pty.lastOutputAt, this.deps.quiescenceMs, lane, () =>
            this.deps.hasCommandPainted(pty.ptyId)
          )
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
      verdict: evaluateTuiIdle(leafTuiIdleEvidence(source, leaf, readWaitText)),
      providerEligible:
        leaf.ptyId === entry.leaf.ptyId &&
        leaf.ptyGeneration === entry.leaf.ptyGeneration &&
        canReadQuietProvider(leaf),
      isCurrent: () =>
        isCurrent() &&
        live().ptyId === entry.leaf.ptyId &&
        live().ptyGeneration === entry.leaf.ptyGeneration,
      ptyId: leaf.ptyId,
      ready: () => buildTerminalWaitResult(handle, 'tui-idle', live()),
      blocked: (reason) => buildTerminalWaitBlockedResult(handle, 'tui-idle', live(), reason),
      isQuiet: (lane) =>
        isQuietForQuiescence(
          live().lastOutputAt,
          this.deps.quiescenceMs,
          lane,
          () => !leaf.ptyId || this.deps.hasCommandPainted(leaf.ptyId)
        )
    }
  }

  private async tick(entry: IdlePollEntry): Promise<void> {
    if (!this.entries.has(entry) || !entry.providerScreen.isCurrent()) {
      return
    }
    let startedForegroundPoll = false
    try {
      let sample = this.sample(entry)
      if (!sample.isCurrent()) {
        return
      }
      const { verdict, ptyId } = sample
      if (verdict.kind === 'blocked') {
        this.settleSample(entry, sample, sample.blocked(verdict.reason))
        return
      }
      // Why strong ready outranks the screen: the detector is not scoped to a region, so dialog
      // wording anywhere on a finished agent's screen would otherwise read as blocked.
      if (verdict.kind === 'ready-strong') {
        this.settleSample(entry, sample, sample.ready())
        return
      }
      // Why no screen read while working: its output can quote dialog wording (a diff of this
      // detector), and the dialogs only the screen shows are start-up ones, painted before any title.
      if (verdict.kind === 'working' || entry.screenReadInFlight) {
        return
      }
      const agent = this.deps.getPaneAgent(ptyId)
      const wholeScreen = readsTrustedScreen(agent)
        ? this.deps.readScreenRuledLines?.(ptyId)
        : this.deps.readScreenLines(ptyId)
      const providerRead =
        entry.providerScreen.available && needsProviderScreen(sample, agent, wholeScreen)
      if (providerRead) {
        await this.readProviderVerdict(entry)
        if (
          !this.entries.has(entry) ||
          !sample.isCurrent() ||
          this.sample(entry).verdict.kind === 'working'
        ) {
          return
        }
      }
      const screenRead = ptyId ? this.readScreenBlockedReason(entry, ptyId) : null
      // Why await only a real read: a pane with no screen model keeps its tick synchronous.
      const screenBlockedReason = screenRead ? await screenRead : null
      if (!this.entries.has(entry) || !sample.isCurrent()) {
        return
      }
      sample = this.sample(entry)
      if (sample.verdict.kind === 'working') {
        return
      }
      if (sample.verdict.kind === 'ready-strong') {
        this.settleSample(entry, sample, sample.ready())
        return
      }
      const reason = sample.verdict.kind === 'blocked' ? sample.verdict.reason : screenBlockedReason
      if (reason) {
        this.settleSample(entry, sample, sample.blocked(reason))
        return
      }
      // A provider refusal still closes weak readiness after the rendered blocker check.
      if (providerRead) {
        return
      }
      if (sample.verdict.kind === 'ready-weak') {
        this.settleSample(entry, sample, sample.ready())
        return
      }
      const lane = sample.verdict.kind === 'pending' ? sample.verdict.quietForeground : 'closed'
      // Why quiet before the read too: a streaming or not-yet-painted pane cannot settle, so it
      // must not pay a process inspection every tick for a whole turn.
      if (lane !== 'closed' && ptyId && !entry.foregroundPollInFlight && sample.isQuiet(lane)) {
        const foregroundRead = this.deps.getForegroundProcess(ptyId)
        if (!foregroundRead) {
          return
        }
        entry.foregroundPollInFlight = true
        startedForegroundPoll = true
        const foreground = await foregroundRead
        if (foreground && !isShellProcess(foreground) && sample.isQuiet(lane)) {
          this.settleSample(entry, sample, sample.ready())
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

  private async readProviderVerdict(entry: IdlePollEntry): Promise<void> {
    entry.screenReadInFlight = true
    try {
      const screen = await entry.providerScreen.read()
      if (!this.entries.has(entry) || !entry.providerScreen.isCurrent() || !screen?.isCurrent()) {
        return
      }
      const sample = this.sample(entry, screen)
      if (!sample.providerEligible || !sample.isCurrent()) {
        return
      }
      if (sample.verdict.kind === 'blocked') {
        this.settleSample(entry, sample, sample.blocked(sample.verdict.reason), screen)
      } else if (sample.verdict.kind === 'ready-strong') {
        this.settleSample(entry, sample, sample.ready(), screen)
      } else if (sample.verdict.kind !== 'working' && sample.ptyId) {
        const reason = await this.readScreenBlockedReason(entry, sample.ptyId, screen)
        if (reason) {
          this.settleSample(entry, sample, sample.blocked(reason), screen)
        }
      }
    } finally {
      entry.screenReadInFlight = false
    }
  }

  /** Why the screen too: a dialog that parks the cursor above its own options (Claude's
   *  workspace trust) loses those rows from the line tail; the rendered screen still has them. */
  private readScreenBlockedReason(
    entry: IdlePollEntry,
    ptyId: string,
    provider?: TuiIdleProviderScreen
  ): Promise<RuntimeTerminalWaitBlockedReason | null> | null {
    const screenRead = provider
      ? Promise.resolve(provider.lines.join('\n'))
      : this.deps.readVisibleScreen(ptyId)
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

  private settleSample(
    entry: IdlePollEntry,
    sample: IdlePollSample,
    result: RuntimeTerminalWait,
    screen?: TuiIdleProviderScreen
  ): void {
    if (
      !this.entries.has(entry) ||
      !entry.providerScreen.isCurrent() ||
      !isCurrentIdleSample(sample, () => this.sample(entry, screen), screen !== undefined)
    ) {
      return
    }
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
