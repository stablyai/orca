import { OrcaRuntimeWithAgentIdentityDiscovery } from './orca-runtime-agent-identity-discovery'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessVerdict
} from '../../shared/agent-process-presence'
import type { AgentPresenceChange } from '../agent-hooks/server/server-row-ownership'
import {
  AGENT_END_FOLLOW_UP_DELAYS_MS,
  AGENT_PRESENCE_FALLBACK_INTERVAL_MS,
  isFencedShellForeground,
  nextAgentPresenceAttemptAtMs,
  readRecognizedForegroundAgent,
  type AgentExitRun
} from './agent-exit-run-registry'
import { probeAgentProcessPresenceBatch } from './agent-process-presence-batch'

/**
 * Proof that the agent run in a PTY exited, never that a shell is empty: the canonical hook owner
 * ended (its own process-ending hook, or the store's probe), or the exact agent PID/start this host
 * measured is gone. Ordinary live status starts no probe; a run without an identity costs at most
 * three fenced captures until something changes.
 */
export class OrcaRuntimeWithAgentExitProof extends OrcaRuntimeWithAgentIdentityDiscovery {
  private readonly agentPresenceNudged = new Set<string>()
  private agentPresenceTickTimer: ReturnType<typeof setTimeout> | null = null
  private agentPresenceTickRunning = false
  /** One pending timed end check per PTY: a slow follow-up or a deferred signal re-check. */
  private readonly agentEndFollowUpTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Targeted presence of known agents on this host (the execution host for local PTYs). */
  protected probeAgentProcessIdentities(
    identities: readonly AgentProcessIdentity[]
  ): Promise<AgentProcessVerdict[]> {
    return probeAgentProcessPresenceBatch(identities)
  }

  /** Overridden by the chat-view layer: a pane clients may show as chat is backed by `ptyId`. */
  protected isAgentExitChatCandidate(_ptyId: string): boolean {
    return false
  }

  /** Overridden by the chat-view layer: act on a proven, revalidated end of `run`. */
  protected onAgentRunExitProven(_run: AgentExitRun, _observedAtMs: number): void {}

  protected forgetAgentExitRun(ptyId: string): void {
    super.forgetAgentExitRun(ptyId)
    this.agentPresenceNudged.delete(ptyId)
    this.clearAgentEndFollowUp(ptyId)
  }

  /** A pane's canonical owner changed: a new owner begins a run; its own end proves this one. */
  noteAgentOwnerPresenceChange(change: AgentPresenceChange): void {
    const ptyId = this.getPtyRecordForPaneKey(change.paneKey)?.ptyId
    const record = ptyId ? this.readAgentExitPty(ptyId) : null
    if (!ptyId || !record) {
      return
    }
    const { presence } = change
    const run = this.agentExitRuns.current(ptyId)
    if (presence && !presence.ended) {
      const sameRun = presence.process
        ? run?.identity && isSameAgentProcess(run.identity, presence.process)
        : run && !run.endHandled && run.agent === presence.agent
      if (!sameRun) {
        // Why before any await: an older run's evidence must never act on this one.
        this.agentExitRuns.begin(ptyId, {
          incarnationId: record.incarnationId,
          agent: presence.agent,
          identity: presence.process ?? null,
          source: 'hook'
        })
        // Why only a chat candidate: an identity nothing will probe is not worth a capture.
        if (!presence.process && this.isAgentExitChatCandidate(ptyId)) {
          this.startAgentIdentityDiscovery(ptyId)
        }
        this.scheduleAgentPresenceTick()
      }
      return
    }
    if (
      presence?.ended &&
      presence.process &&
      run?.identity &&
      run.incarnationId === record.incarnationId &&
      isSameAgentProcess(run.identity, presence.process)
    ) {
      run.ownerEndedAtMs ??= Date.now()
      this.handleAgentRunEnd(run, run.ownerEndedAtMs)
    } else if (!presence && run?.identity) {
      // Why only a look: a removed row (transport blip, cleanup) is not proof of anything.
      this.nudgeAgentPresenceCheck(ptyId)
    }
  }

  /** A title exit or a finished shell command: a reason to look at a known agent now. */
  protected nudgeAgentExitCheck(ptyId: string): void {
    const run = this.agentExitRuns.current(ptyId)
    if (!run?.identity || !this.isAgentExitChatCandidate(ptyId)) {
      return
    }
    if (run.ownerEndedAtMs !== undefined) {
      // Why: the owner already said it ended; the hook can precede the process leaving the pane.
      this.handleAgentRunEnd(run, run.ownerEndedAtMs, { changeSignal: true })
    } else {
      this.nudgeAgentPresenceCheck(ptyId)
    }
  }

  /** Recognized agent activity: a chat pane with no live identified run may now be measurable. */
  protected noteNativeChatAgentEvidence(ptyId: string): void {
    if (this.needsAgentIdentity(ptyId) && this.isAgentExitChatCandidate(ptyId)) {
      this.startAgentIdentityDiscovery(ptyId, { evidence: true })
    }
  }

  /** No identified run, or only one whose process is gone: a later agent here is still unknown. */
  protected needsAgentIdentity(ptyId: string): boolean {
    const run = this.agentExitRuns.current(ptyId)
    return !run?.identity || run.exitProven || run.processGone
  }

  private nudgeAgentPresenceCheck(ptyId: string): void {
    this.agentPresenceNudged.add(ptyId)
    this.scheduleAgentPresenceTick(0)
  }

  /** One timer for every identified run: the earliest due fallback, or now for a nudge. */
  protected scheduleAgentPresenceTick(delayMs?: number): void {
    const now = Date.now()
    const due =
      delayMs ??
      Math.min(
        ...this.agentExitRuns
          .all()
          .filter((run) => this.isProbeEligible(run))
          .map((run) => run.nextProbeAtMs - now)
      )
    if (!Number.isFinite(due) || this.agentPresenceTickRunning) {
      return
    }
    if (this.agentPresenceTickTimer) {
      clearTimeout(this.agentPresenceTickTimer)
    }
    this.agentPresenceTickTimer = setTimeout(
      () => void this.runAgentPresenceTick(),
      Math.max(0, due)
    )
    this.agentPresenceTickTimer.unref?.()
  }

  private isProbeEligible(run: AgentExitRun): boolean {
    const record = this.readAgentExitPty(run.ptyId)
    return Boolean(
      run.identity &&
      !run.endHandled &&
      record &&
      record.incarnationId === run.incarnationId &&
      this.canProbeAgentProcessLocally(record) &&
      this.isAgentExitChatCandidate(run.ptyId)
    )
  }

  protected async runAgentPresenceTick(): Promise<void> {
    this.agentPresenceTickTimer = null
    this.agentPresenceTickRunning = true
    const startedAtMs = Date.now()
    try {
      const due = this.agentExitRuns
        .all()
        .filter(
          (run) =>
            this.isProbeEligible(run) &&
            (this.agentPresenceNudged.has(run.ptyId) || run.nextProbeAtMs <= startedAtMs)
        )
      const nudged = new Set(this.agentPresenceNudged)
      this.agentPresenceNudged.clear()
      const identities = due.flatMap((run) => (run.identity ? [run.identity] : []))
      const verdicts =
        identities.length > 0 ? await this.probeAgentProcessIdentities(identities) : []
      due.forEach((run, index) => {
        const verdict = verdicts[index]
        if (!this.agentExitRuns.isCurrent(run) || run.endHandled) {
          return
        }
        if (verdict === 'exited') {
          run.processGone = true
          // Why: an end that stays unproven is not re-probed before its next allowed end check.
          run.nextProbeAtMs = Math.max(
            Date.now() + AGENT_PRESENCE_FALLBACK_INTERVAL_MS,
            run.nextEndCheckAtMs
          )
          this.handleAgentRunEnd(run, startedAtMs, { changeSignal: nudged.has(run.ptyId) })
          return
        }
        run.failedProbes = verdict === 'live' ? 0 : run.failedProbes + 1
        run.nextProbeAtMs =
          verdict === 'live'
            ? Date.now() + AGENT_PRESENCE_FALLBACK_INTERVAL_MS
            : nextAgentPresenceAttemptAtMs(run.failedProbes)
      })
    } finally {
      this.agentPresenceTickRunning = false
      this.scheduleAgentPresenceTick(this.agentPresenceNudged.size > 0 ? 0 : undefined)
    }
  }

  /**
   * An end observed for `run`. Before acting, one fenced read of the owning host makes sure the
   * pane has not already moved on to a replacement agent (same name included): that run is adopted
   * instead, and an unreadable host leaves the end unproven. A `changeSignal` (title exit, finished
   * command) re-arms a backed-off check, at most once per fallback interval.
   */
  protected handleAgentRunEnd(
    run: AgentExitRun,
    observedAtMs: number,
    options: { changeSignal?: boolean } = {}
  ): void {
    const inspect = this.ptyController?.inspectProcess
    const checkStartedAtMs = Date.now()
    const allowed =
      checkStartedAtMs >= run.nextEndCheckAtMs ||
      (options.changeSignal === true &&
        checkStartedAtMs >= run.lastEndCheckAtMs + AGENT_PRESENCE_FALLBACK_INTERVAL_MS)
    if (run.endHandled && options.changeSignal && this.agentExitRuns.isCurrent(run)) {
      // Why: the in-flight check may predate this signal (e.g. the agent was still in front).
      run.endRecheckPending = true
      return
    }
    if (!inspect || run.endHandled || !this.agentExitRuns.isCurrent(run) || !allowed) {
      return
    }
    run.endHandled = true
    run.lastEndCheckAtMs = checkStartedAtMs
    void inspect
      .call(
        this.ptyController,
        run.ptyId,
        run.incarnationId ? { expectedIncarnationId: run.incarnationId } : {}
      )
      .catch(() => null)
      .then(async (inspection) => {
        if (
          !this.agentExitRuns.isCurrent(run) ||
          this.readAgentExitPty(run.ptyId)?.incarnationId !== run.incarnationId
        ) {
          return
        }
        if (isFencedShellForeground(inspection, run.incarnationId)) {
          this.clearAgentEndFollowUp(run.ptyId)
          run.exitProven = true
          this.recordProvenAgentEnd(run, checkStartedAtMs)
          this.onAgentRunExitProven(run, observedAtMs)
          return
        }
        const replacement = readRecognizedForegroundAgent(inspection, run.incarnationId)
        if (replacement && replacement.pid !== run.identity?.pid) {
          const record = this.readAgentExitPty(run.ptyId)
          // Why local only: a remote PID means nothing in this host's process table.
          const identity =
            record && this.canProbeAgentProcessLocally(record)
              ? await this.bootstrapAgentIdentity(replacement)
              : null
          if (this.agentExitRuns.isCurrent(run)) {
            this.clearAgentEndFollowUp(run.ptyId)
            this.agentExitRuns.begin(run.ptyId, {
              incarnationId: run.incarnationId,
              agent: replacement.agent,
              identity,
              source: 'foreground'
            })
            this.scheduleAgentPresenceTick()
          }
          return
        }
        // Why reopen: unverifiable now is not an exit; a later signal may prove it.
        run.endHandled = false
        if (replacement?.pid !== run.identity?.pid) {
          // Why back off: an unreadable pane must not cost a capture per publish or nudge.
          run.failedEndChecks += 1
          run.nextEndCheckAtMs = nextAgentPresenceAttemptAtMs(run.failedEndChecks)
          this.scheduleAgentEndFollowUp(run, observedAtMs)
        }
        if (run.endRecheckPending) {
          this.scheduleAgentEndRecheck(run, observedAtMs)
        }
      })
      .catch((error: unknown) => {
        // Why: a throw must neither strand the run nor reject unhandled (orcad has no handler).
        console.warn('[native-chat] agent exit check failed', error)
        if (this.agentExitRuns.isCurrent(run) && !run.exitProven) {
          run.endHandled = false
        }
      })
  }

  /** The signal that arrived mid-check gets one more check, as soon as a check is admitted. */
  private scheduleAgentEndRecheck(run: AgentExitRun, observedAtMs: number): void {
    run.endRecheckPending = false
    this.clearAgentEndFollowUp(run.ptyId)
    // Why the earlier of the two: the same rule admits a check (unproven: now; backed off: 15 s).
    const delay = Math.max(
      0,
      Math.min(run.nextEndCheckAtMs, run.lastEndCheckAtMs + AGENT_PRESENCE_FALLBACK_INTERVAL_MS) -
        Date.now()
    )
    const timer = setTimeout(() => {
      this.agentEndFollowUpTimers.delete(run.ptyId)
      if (this.agentExitRuns.isCurrent(run) && this.isAgentExitChatCandidate(run.ptyId)) {
        this.handleAgentRunEnd(run, observedAtMs, { changeSignal: true })
      }
    }, delay)
    timer.unref?.()
    this.agentEndFollowUpTimers.set(run.ptyId, timer)
  }

  /**
   * After a failed end check of a run whose process the probe found gone: one slow, timed look
   * (2, 5, 10 min after each failure, three in all), since an idle shell sends no change signal.
   * Dies with the run, the PTY or the pane's chat candidacy.
   */
  private scheduleAgentEndFollowUp(run: AgentExitRun, observedAtMs: number): void {
    const delay = AGENT_END_FOLLOW_UP_DELAYS_MS[run.endFollowUps]
    if (!run.processGone || delay === undefined) {
      return
    }
    this.clearAgentEndFollowUp(run.ptyId)
    const timer = setTimeout(() => {
      this.agentEndFollowUpTimers.delete(run.ptyId)
      if (!this.isProbeEligible(run)) {
        return
      }
      run.endFollowUps += 1
      this.handleAgentRunEnd(run, observedAtMs, { changeSignal: true })
    }, delay)
    timer.unref?.()
    this.agentEndFollowUpTimers.set(run.ptyId, timer)
  }

  private clearAgentEndFollowUp(ptyId: string): void {
    const timer = this.agentEndFollowUpTimers.get(ptyId)
    if (timer) {
      clearTimeout(timer)
      this.agentEndFollowUpTimers.delete(ptyId)
    }
  }

  /**
   * One owner of agent presence: a proven end of an owner no hook identified is written there,
   * unless a hook reached it after the proving check began (a newer run may own it now).
   */
  private recordProvenAgentEnd(run: AgentExitRun, checkStartedAtMs: number): void {
    if (!run.agent || !this.recordHostProvenAgentEndFn) {
      return
    }
    for (const paneKey of this.collectAgentStatusPaneKeysForPty(run.ptyId)) {
      this.recordHostProvenAgentEndFn(paneKey, run.agent, checkStartedAtMs)
    }
  }
}
