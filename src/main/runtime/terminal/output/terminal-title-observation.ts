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
    // Classify raw titles but store normalized labels to collapse spinner churn (#7880). Identity-only cursor titles affect display without activity evidence (#10258).
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
      // Re-offer idle-to-idle upgrades from name-only to explicit evidence; exclude permission-to-idle and unchanged repaints to avoid tail rescans.
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
      // Retain live titles for worktree.ps recomputation, including shell titles that clear stale working state (#1437).
      const prevStatus = leaf.lastAgentStatus
      const prevObservedLive = leaf.lastAgentStatusObservedLive
      const leafTitleChanged = !statusOnly && leaf.lastOscTitle !== recordedTitle
      if (!statusOnly) {
        leaf.lastOscTitle = recordedTitle
        leaf.lastOscTitleAt = identityOnlyTitle ? null : this.nextTitleObservationSequence()
      }
      // Non-agent titles clear sticky status; new waiters fall back to live title detection/polling.
      leaf.lastAgentStatus = agentStatus
      leaf.lastAgentStatusObservedLive = true
      // Fast agents can skip working; accept transitions to idle except permission-to-idle. Also re-offer changed idle-to-idle evidence, never unchanged repaint.
      if (
        agentStatus === 'idle' &&
        prevStatus !== 'permission' &&
        (prevStatus !== agentStatus || leafTitleChanged)
      ) {
        this.resolveTuiIdleWaiters(leaf)
      }
      // First live idle after seed/respawn authorizes delivery; later explicit-ready titles must also re-offer idle-to-idle upgrades (#12536).
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

  /** Stale-working clears are display guesses, never readiness/delivery evidence; refresh foreground process and exit/completion evidence without changing title/status records or waiters. */
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
    // Reused PTY ids must not inherit predecessor title/parser state.
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
