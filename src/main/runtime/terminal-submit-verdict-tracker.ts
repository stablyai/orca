// Why: Orca owns the PTY and already receives every harness's own turn-lifecycle hook, so it can
// answer "did the agent take this text into a turn?" from that signal instead of scraping the
// rendered screen. This tracker is the join between a write and the hook event that proves it.

import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusState } from '../../shared/agent-status-types'
import {
  classifyAgentSubmitSignal,
  harnessReportsSubmitSignal,
  type AgentSubmitSignalKind
} from '../../shared/agent-submit-signal'
import type { TerminalSubmitVerdict } from '../../shared/terminal-submit-verdict'

export type AgentSubmitHookEvent = {
  paneKey: string
  source: AgentHookSource
  hookEventName?: string
  hasExplicitPrompt?: boolean
  state: AgentStatusState
  /** Cached rows replayed to a new listener; they describe the past, not this send. */
  isReplay?: boolean
  /** Rows rebuilt from disk at hydrate; the agent behind them was never observed in this runtime. */
  restoredUnconfirmed?: boolean
}

type PaneSubmitEvidence = {
  source: AgentHookSource
  state: AgentStatusState
  observedAt: number
}

export type TerminalSubmitWatch = {
  /** Wait for harness evidence, bounded by `timeoutMs`. Safe to call again after a submit retry;
   *  evidence already seen resolves immediately and `waitedMs` keeps accumulating. */
  settle(timeoutMs: number): Promise<TerminalSubmitVerdict>
  release(): void
}

/** Panes remembered for evidence. Bounded so a long-lived runtime that churns panes cannot grow
 *  the map without limit; eviction only costs a pane its `pending`/`queued` precision. */
const MAX_TRACKED_PANES = 512

class SubmitWatch implements TerminalSubmitWatch {
  private signal: { kind: AgentSubmitSignalKind; hasExplicitPrompt: boolean } | null = null
  private wake: (() => void) | null = null
  private waitedMs = 0
  private released = false

  constructor(
    private readonly evidence: PaneSubmitEvidence | null,
    private readonly onRelease: (watch: SubmitWatch) => void
  ) {}

  private get busyAtSend(): boolean {
    return this.evidence?.state === 'working'
  }

  private get reportsSubmit(): boolean {
    return this.evidence !== null && harnessReportsSubmitSignal(this.evidence.source)
  }

  notify(kind: AgentSubmitSignalKind, hasExplicitPrompt: boolean): void {
    if (this.signal || this.released) {
      return
    }
    // Why: some turn-start events (Hermes `pre_llm_call`) also fire for mid-turn continuations. When
    // a turn was already running and the event carries no submitted prompt, it is not ours to claim.
    if (kind === 'turn-start' && this.busyAtSend && !hasExplicitPrompt) {
      return
    }
    this.signal = { kind, hasExplicitPrompt }
    this.wake?.()
  }

  async settle(timeoutMs: number): Promise<TerminalSubmitVerdict> {
    if (!this.signal && !this.released && timeoutMs > 0) {
      const startedAt = Date.now()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null
          resolve()
        }, timeoutMs)
        this.wake = () => {
          clearTimeout(timer)
          this.wake = null
          resolve()
        }
      })
      this.waitedMs += Date.now() - startedAt
    }
    return this.verdict()
  }

  private verdict(): TerminalSubmitVerdict {
    const waitedMs = this.waitedMs
    if (this.signal) {
      if (this.signal.kind === 'user-message') {
        return this.busyAtSend
          ? { status: 'queued', reason: 'accepted-mid-turn', waitedMs }
          : { status: 'submitted', reason: 'message-accepted', waitedMs }
      }
      return { status: 'submitted', reason: 'turn-start-observed', waitedMs }
    }
    if (!this.evidence) {
      return { status: 'unknown', reason: 'no-live-hook-evidence', waitedMs }
    }
    if (!this.reportsSubmit) {
      return { status: 'unknown', reason: 'harness-has-no-turn-start-signal', waitedMs }
    }
    if (this.busyAtSend) {
      // Why: harnesses that queue mid-turn input act on it only when the current turn ends, which
      // can be minutes away. Silence inside our bound is not evidence the Enter was swallowed.
      return { status: 'unknown', reason: 'sent-mid-turn', waitedMs }
    }
    return { status: 'pending', reason: 'no-turn-start-observed', waitedMs }
  }

  release(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.wake?.()
    this.onRelease(this)
  }
}

export class TerminalSubmitVerdictTracker {
  private evidenceByPaneKey = new Map<string, PaneSubmitEvidence>()
  private watchesByPaneKey = new Map<string, Set<SubmitWatch>>()

  /** Feed every live hook event, in the order the hook server accepted it. */
  noteHookEvent(event: AgentSubmitHookEvent, now = Date.now()): void {
    if (event.isReplay === true || event.restoredUnconfirmed === true) {
      return
    }
    const { paneKey } = event
    // Why re-insert: Map keeps insertion order, so deleting first makes the eviction below drop the
    // least recently active pane rather than the oldest-created one.
    this.evidenceByPaneKey.delete(paneKey)
    this.evidenceByPaneKey.set(paneKey, {
      source: event.source,
      state: event.state,
      observedAt: now
    })
    while (this.evidenceByPaneKey.size > MAX_TRACKED_PANES) {
      const oldest = this.evidenceByPaneKey.keys().next()
      if (oldest.done) {
        break
      }
      this.evidenceByPaneKey.delete(oldest.value)
    }
    const kind = classifyAgentSubmitSignal(event.source, event)
    if (!kind) {
      return
    }
    for (const watch of this.watchesByPaneKey.get(paneKey) ?? []) {
      watch.notify(kind, event.hasExplicitPrompt === true)
    }
  }

  /** Arm BEFORE writing to the PTY: a fast harness can report the turn start before the write call
   *  even returns, and a watch armed afterwards would miss it and report a false `pending`. */
  beginWatch(paneKey: string | null, now = Date.now()): TerminalSubmitWatch {
    if (!paneKey) {
      return {
        settle: async () => ({ status: 'unknown', reason: 'no-pane-identity', waitedMs: 0 }),
        release: () => {}
      }
    }
    const stored = this.evidenceByPaneKey.get(paneKey)
    // Why the staleness bound: hooks can be uninstalled or the CLI replaced between turns, so an
    // old row proves nothing about whether this harness still reports to us. Same convention as
    // explicit agent status — stale evidence is unknown, never a claim.
    const evidence =
      stored && now - stored.observedAt <= AGENT_STATUS_STALE_AFTER_MS ? stored : null
    const watch = new SubmitWatch(evidence, (released) => {
      const watches = this.watchesByPaneKey.get(paneKey)
      if (!watches) {
        return
      }
      watches.delete(released)
      if (watches.size === 0) {
        this.watchesByPaneKey.delete(paneKey)
      }
    })
    const watches = this.watchesByPaneKey.get(paneKey)
    if (watches) {
      watches.add(watch)
    } else {
      this.watchesByPaneKey.set(paneKey, new Set([watch]))
    }
    return watch
  }

  forgetPane(paneKey: string): void {
    this.evidenceByPaneKey.delete(paneKey)
  }
}
