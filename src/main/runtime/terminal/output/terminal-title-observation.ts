import type { AgentStatus } from '../../../../shared/agent-detection'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord
} from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './terminal-title-tracker'
import type { TerminalTitleFactMeta } from '../../../../shared/terminal-output-side-effects'
import { detectAgentStatusFromTitle } from '../../../../shared/agent-detection'
import { terminalTitleBlocksExplicitAgentStatus } from '../../runtime-worktree-status-projection'
import type { ClaudeTerminalEvidence } from '../../../../shared/claude-terminal-interrupt'

export abstract class OrcaRuntimeWithApplyTrackedPtyTitle extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  protected abstract collectPaneKeysForPty(ptyId: string): Set<string>
  protected abstract recordAgentPromptLifecycleState(
    ptyId: string,
    status: AgentStatus | null
  ): void
  protected abstract nextTitleObservationSequence(): number
  protected abstract setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void
  protected abstract resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void
  protected abstract shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean
  protected abstract getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined
  protected abstract delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void
  protected abstract resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void
  protected abstract checkDeliverySettledAndArmRecheck(leaf: {
    tabId: string
    leafId: string
  }): boolean
  protected abstract deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void
  protected abstract clearAgentPromptCorrelationForPty(ptyId: string): void
  protected abstract collectAgentStatusPaneKeysForPty(ptyId: string): Set<string>
  protected abstract markPaneLiveTitlesDirty(): void

  observeClaudeTerminalEvidence(ptyId: string, evidence: ClaudeTerminalEvidence): void {
    if (!this.onClaudeTerminalEvidence || this.ptysById.get(ptyId)?.connectionId) {
      return
    }
    for (const paneKey of this.collectPaneKeysForPty(ptyId)) {
      this.onClaudeTerminalEvidence(paneKey, evidence)
    }
  }

  /** The PTY's agent status under this title: the program's own OSC 7501 activity while it
   *  reports one, else what the title glyph says. */
  protected classifyPtyTitleStatus(ptyId: string, rawTitle: string): AgentStatus | null {
    return (
      this.ptyTitleTrackersByPtyId.get(ptyId)?.programActivity ??
      detectAgentStatusFromTitle(rawTitle)
    )
  }

  /** Re-classifies the PTY under new program activity; on null the title's own glyph decides again. */
  protected applyPtyProgramActivity(ptyId: string, activity: AgentStatus | null): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (!entry) {
      return
    }
    entry.programActivity = activity
    this.observeClaudeTerminalEvidence(ptyId, { kind: 'activity', status: activity })
    const pty = this.ptysById.get(ptyId)
    if (activity === null && pty?.lastExplicitAgentStatus?.programAtRest) {
      // The at-rest claim was the program's; a later agent in this pane must earn its own.
      const { programAtRest: _ended, ...status } = pty.lastExplicitAgentStatus
      pty.lastExplicitAgentStatus = status
    }
    if (entry.lastTitle) {
      // A stale-spinner clear stands for the title it replaced, so a dead spinner is not revived.
      const raw = pty?.titleDisplayClear?.title ?? entry.lastTitle.raw
      const changed = this.applyTrackedPtyTitle(ptyId, raw, entry.lastTitle.normalized, undefined, {
        statusOnly: true
      })
      // The chunk's session-tab fan-out carries the new status to mobile.
      if (changed && entry.applyingChunk) {
        entry.chunkTouchedSessionTabs = true
      }
    }
  }

  /** Apply one observed OSC title (raw form) to the PTY and leaf records.
   *  Returns true when what the PTY shows changed: its record, or its display-only clear. */
  protected applyTrackedPtyTitle(
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string,
    meta?: TerminalTitleFactMeta,
    /** `statusOnly`: no title was observed, so title evidence, clocks and display stay as they are. */
    { statusOnly = false }: { statusOnly?: boolean } = {}
  ): boolean {
    if (meta?.staleWorkingTitleClear) {
      return this.applyStaleWorkingTitleClear(ptyId, rawTitle, normalizedTitle)
    }
    if (!statusOnly) {
      this.observeClaudeTerminalEvidence(ptyId, { kind: 'title', title: rawTitle })
    }
    // Why: status is detected from the RAW title (mirrors the renderer tracker),
    // so working/idle transitions are unaffected by normalization; the records
    // store the NORMALIZED title so rotating Grok/Pi/Gemini frames collapse to
    // one stable stored label (#7880) instead of churning `ps`/mobile tabs.
    //
    // Why the identity-only case: the bare cursor-agent literal identifies the pane without
    // asserting activity, so it records NO title/status evidence — only the tracker keeps it,
    // for display (#10258). Nulling the status here rather than trusting the detector keeps
    // that contract local, since every activity-gated effect below is keyed on status.
    const identityOnlyTitle = this.isLiveCursorNativeTitle(rawTitle, meta)
    const recordedTitle = statusOnly
      ? (this.ptysById.get(ptyId)?.lastOscTitle ?? null)
      : identityOnlyTitle
        ? null
        : normalizedTitle
    const agentStatus = identityOnlyTitle ? null : this.classifyPtyTitleStatus(ptyId, rawTitle)
    // Why before retiring the clear: the lifecycle counts a turn from the status the clear showed.
    this.recordAgentPromptLifecycleState(ptyId, agentStatus)
    let ptyRecordChanged = false
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const prevStatus = pty.lastAgentStatus
      const prevTitle = pty.lastOscTitle
      const observedAt = this.nextTitleObservationSequence()
      const observedAtEpochMs = identityOnlyTitle ? null : Date.now()
      if (!statusOnly) {
        pty.titleDisplayClear = null
        pty.lastOscTitle = recordedTitle
        pty.lastOscTitleAt = identityOnlyTitle ? null : observedAt
        pty.lastOscTitleEpochMs = observedAtEpochMs
      }
      pty.lastAgentStatus = agentStatus
      pty.lastAgentStatusObservedLive = true
      if (prevStatus === 'working' && agentStatus === null) {
        this.confirmPtyAgentExit(ptyId, true)
      }
      if (prevStatus !== agentStatus) {
        pty.lastAgentStatusStartedAtEpochMs = observedAtEpochMs
      }
      if (
        identityOnlyTitle ||
        terminalTitleBlocksExplicitAgentStatus(recordedTitle) ||
        (prevStatus !== null && agentStatus !== null && prevStatus !== agentStatus)
      ) {
        pty.lastAgentStatusRichInvalidatedAtEpochMs = observedAtEpochMs ?? Date.now()
      }
      if (!statusOnly && identityOnlyTitle) {
        pty.managementTitle = null
        pty.managementTitleAt = null
      } else if (!statusOnly) {
        this.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt)
      }
      ptyRecordChanged = prevTitle !== recordedTitle || prevStatus !== agentStatus
      // Why `!== 'permission'` rather than `!== 'idle'`: a name-only idle leaves the waiter
      // parked on its poll, so the later explicit idle is an idle→idle step that still has
      // to be offered. The resolve helper re-ranks and returns early when it is not yet
      // satisfying evidence, which is what the old edge guard was really protecting.
      // Why also gated on a change: the resolver settles only a blocked tail or strong
      // ready, and the poll catches either between title changes; repainted frames would
      // otherwise re-scan the pane tail for nothing.
      if (agentStatus === 'idle' && prevStatus !== 'permission' && ptyRecordChanged) {
        this.resolvePtyTuiIdleWaiters(pty, ptyId)
      }
      const shouldDelayMobileSnapshot =
        ptyRecordChanged &&
        this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, normalizedTitle)
      let foregroundRefresh: Promise<boolean> | undefined
      // Why: gate on an actual status transition — braille spinner frames
      // mutate the title every tick, so probing per-title-change would stream
      // a foreground query per frame during active work.
      if (prevStatus !== agentStatus) {
        foregroundRefresh = this.ptyForegroundAgent.refresh(ptyId, observedAt)
      } else if (shouldDelayMobileSnapshot) {
        // Why: same-status compatible title changes can arrive before the
        // foreground owner probe settles; publishing them would flicker.
        foregroundRefresh = this.getPendingForegroundAgentRefreshForTitle(ptyId, observedAt)
      }
      if (foregroundRefresh && shouldDelayMobileSnapshot) {
        // Why: report "unchanged" so the per-chunk batch skips the mobile
        // snapshot fan-out; the delayed publish fires when the probe settles.
        ptyRecordChanged = false
        this.delayPtyBackedMobileSnapshotForForegroundAgent(ptyId, observedAt, foregroundRefresh)
      }
    }
    if (agentStatus === 'working' || agentStatus === 'permission') {
      this.orchestrationMailboxPointerDelivery.observeAgentWorking(ptyId)
    } else if (agentStatus === 'idle') {
      this.orchestrationMailboxPointerDelivery.observeAgentIdle(ptyId)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: keep the latest OSC title on the leaf so worktree.ps can
      // recompute status from the live title each call. Without this,
      // daemon-hosted terminals (no renderer pushing pane titles) had no
      // way to clear a stale 'working' status after the agent exited and
      // the shell took over the title — the stuck-spinner bug in #1437.
      const prevStatus = leaf.lastAgentStatus
      const prevObservedLive = leaf.lastAgentStatusObservedLive
      const leafTitleChanged = !statusOnly && leaf.lastOscTitle !== recordedTitle
      if (!statusOnly) {
        leaf.lastOscTitle = recordedTitle
        leaf.lastOscTitleAt = identityOnlyTitle ? null : this.nextTitleObservationSequence()
      }
      // Why: when a new OSC title doesn't classify as an agent state (e.g.
      // bare shell title after the agent exits), clear lastAgentStatus so
      // it is no longer sticky. Tui-idle waiters that needed the previous
      // 'idle' transition were already resolved at the moment of the
      // transition below; only fresh waiters registered after the agent
      // exits would observe the cleared value, and they correctly fall
      // back to title-based detection / polling.
      leaf.lastAgentStatus = agentStatus
      leaf.lastAgentStatusObservedLive = true
      // Why: resolve tui-idle on any transition TO idle (not just working→idle).
      // Claude Code may skip "working" entirely on fast tasks, going null→idle,
      // and the coordinator's tui-idle waiter would hang forever waiting for a
      // working→idle transition that never comes. Permission→idle is excluded:
      // it means the agent was blocked on user approval and the user said no,
      // which isn't a task-completion signal.
      // Why not `prevStatus !== 'idle'`: see the pty branch — the resolve helper re-ranks,
      // so an idle→idle step that upgrades weak evidence to explicit must still be offered.
      // Why the change gate: see the pty branch — repainted frames must not re-scan the tail.
      if (
        agentStatus === 'idle' &&
        prevStatus !== 'permission' &&
        (prevStatus !== agentStatus || leafTitleChanged)
      ) {
        this.resolveTuiIdleWaiters(leaf)
      }
      // Why the second condition: push delivery is gated on LIVE idle, so its
      // authorizing edge is liveness as well as status. A restore seed or a
      // status kept across a same-id respawn leaves a stale 'idle' behind, and
      // an agent whose first live title is already idle (claude --resume at its
      // prompt) then shows no transition — the row would strand, which is
      // exactly #12536. Waiter semantics stay transition-only above.
      // Why the title change joins the edge: a name-only frame routinely lands before the
      // hook's `X ready`, and it consumes the working→idle transition. The later ready title
      // is an idle→idle step, so gating delivery on `prevStatus !== 'idle'` meant the
      // strongest evidence this pane will ever emit never reached delivery at all. The
      // waiter branch above already re-offers on that step; the gate makes a repeat harmless.
      if (
        agentStatus === 'idle' &&
        (prevStatus !== 'idle' || !prevObservedLive || leafTitleChanged) &&
        this.checkDeliverySettledAndArmRecheck(leaf)
      ) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }
    return ptyRecordChanged
  }

  /**
   * The stale-working timer's clear: it only guesses that the agent may have exited behind a
   * working title. Of what a genuine title does, it skips the title/status evidence that
   * readiness and delivery read (records, waiters, mailbox, delivery), and still re-derives the
   * process evidence that guess is about: the foreground agent and the exit/completion check.
   * Display takes the cleared title from `titleDisplayClear`; the caller publishes it.
   */
  private applyStaleWorkingTitleClear(
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string
  ): boolean {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return false
    }
    const nativeStatus = pty.lastAgentStatus
    const clearedStatus = this.classifyPtyTitleStatus(ptyId, rawTitle)
    const observedAt = this.nextTitleObservationSequence()
    const previousTitle = pty.titleDisplayClear?.title ?? pty.lastOscTitle
    pty.titleDisplayClear = { title: normalizedTitle, observedAt, observedAtEpochMs: Date.now() }
    if (nativeStatus === 'working' && clearedStatus === null) {
      this.confirmPtyAgentExit(ptyId, true)
    }
    if (nativeStatus === clearedStatus) {
      return previousTitle !== normalizedTitle
    }
    const foregroundRefresh = this.ptyForegroundAgent.refresh(ptyId, observedAt)
    if (this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, normalizedTitle)) {
      this.delayPtyBackedMobileSnapshotForForegroundAgent(ptyId, observedAt, foregroundRefresh)
      return false
    }
    return true
  }

  /** Cancel the per-PTY title tracker (stale-title timer included) on PTY
   *  teardown so it cannot fire into pruned records. */
  protected disposePtyTitleTracker(ptyId: string): void {
    this.observeClaudeTerminalEvidence(ptyId, { kind: 'reset' })
    this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.dispose()
    this.ptyTitleTrackersByPtyId.delete(ptyId)
    this.ptyForegroundAgent.clearDelayedSnapshot(ptyId)
    this.openCodeRunLifetime.forgetPty(ptyId)
    this.mobileSessionTabsAgentStatusHeartbeat.removePty(ptyId)
    this.clientEvents.clearPtyTitleGate(ptyId)
  }

  protected resetTrackedTerminalStateForProviderGeneration(ptyId: string): void {
    // Why: a replacement daemon session can reuse the PTY id, but title/parser
    // state from the prior process must not bleed into its snapshots or chunks.
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.agentPromptLifecycleByPtyId.delete(ptyId)
    this.agentPromptPermissionSequenceByPtyId.delete(ptyId)
    this.clearAgentPromptCorrelationForPty(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.lastOscTitle = null
      pty.lastOscTitleAt = null
      pty.lastOscTitleEpochMs = null
      pty.titleDisplayClear = null
      pty.lastAgentStatus = null
      // Why: the prior process's first-party status would otherwise veto idle for its
      // replacement — a stale `working` keeps tui-idle unresolved on the new generation.
      pty.lastExplicitAgentStatus = null
      // Why: the prior process's live frames say nothing about the replacement,
      // so the seed a same-id restore applies must not inherit its authority.
      pty.lastAgentStatusObservedLive = false
      pty.lastAgentStatusStartedAtEpochMs = null
      pty.lastAgentStatusRichInvalidatedAtEpochMs = Date.now()
      pty.providerGenerationResetAtEpochMs = pty.lastAgentStatusRichInvalidatedAtEpochMs
      pty.managementTitle = null
      pty.managementTitleAt = null
      pty.waitBlockedAt = null
      pty.tailWaitState = undefined
      pty.commandPaint = undefined
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.lastOscTitle = null
      leaf.lastOscTitleAt = null
      leaf.lastAgentStatus = null
      leaf.lastAgentStatusObservedLive = false
      leaf.waitBlockedAt = null
      leaf.tailWaitState = undefined
    }
    this.markPaneLiveTitlesDirty()
    this.reconcileAgentStatusForEndedProcessFn?.(this.collectAgentStatusPaneKeysForPty(ptyId))
    this.primeWaitBlockedBaselineFromSeededTail(ptyId)
  }

  protected setTerminalSideEffectConsumerAvailable(available: boolean): void {
    this.terminalSideEffectLocalConsumerAvailable = available && this.onTerminalSideEffects !== null
    this.refreshTerminalSideEffectConsumerAvailability()
  }

  protected refreshTerminalSideEffectConsumerAvailability(): void {
    const nextAvailable =
      this.terminalSideEffectLocalConsumerAvailable ||
      this.countTerminalSideEffectConsumingClientEventListeners() > 0
    if (nextAvailable === this.terminalSideEffectConsumerAvailable) {
      return
    }
    this.terminalSideEffectConsumerAvailable = nextAvailable
    for (const [ptyId, entry] of this.ptyTitleTrackersByPtyId) {
      entry.tracker.setTransientSideEffectScanningEnabled(nextAvailable)
      entry.commandCodeDetector = nextAvailable
        ? this.createTerminalSideEffectCommandCodeDetector(ptyId)
        : null
    }
  }
}
