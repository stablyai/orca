// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './orca-runtime-get-unpersisted-tracked-title-for-pty'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'

export class OrcaRuntimeWithApplyTrackedPtyTitle extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  /** Apply one observed OSC title (raw form) to the PTY and leaf records.
   *  Returns true when the PTY record's title or status changed. */
  protected applyTrackedPtyTitle(
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string,
    meta?: TerminalTitleFactMeta
  ): boolean {
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
    const recordedTitle = identityOnlyTitle ? null : normalizedTitle
    const agentStatus = identityOnlyTitle ? null : detectAgentStatusFromTitle(rawTitle)
    this.recordAgentPromptLifecycleState(ptyId, agentStatus)
    let ptyRecordChanged = false
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const prevStatus = pty.lastAgentStatus
      const prevTitle = pty.lastOscTitle
      const observedAt = this.nextTitleObservationSequence()
      const observedAtEpochMs = identityOnlyTitle ? null : Date.now()
      pty.lastOscTitle = recordedTitle
      pty.lastOscTitleAt = identityOnlyTitle ? null : observedAt
      pty.lastOscTitleEpochMs = observedAtEpochMs
      pty.lastAgentStatus = agentStatus
      pty.lastAgentStatusObservedLive = true
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
      if (identityOnlyTitle) {
        pty.managementTitle = null
        pty.managementTitleAt = null
      } else {
        this.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt)
      }
      ptyRecordChanged = prevTitle !== recordedTitle || prevStatus !== agentStatus
      if (agentStatus === 'idle' && prevStatus !== 'idle') {
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
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: keep the latest OSC title on the leaf so worktree.ps can
      // recompute status from the live title each call. Without this,
      // daemon-hosted terminals (no renderer pushing pane titles) had no
      // way to clear a stale 'working' status after the agent exited and
      // the shell took over the title — the stuck-spinner bug in #1437.
      const prevStatus = leaf.lastAgentStatus
      const prevObservedLive = leaf.lastAgentStatusObservedLive
      leaf.lastOscTitle = recordedTitle
      leaf.lastOscTitleAt = identityOnlyTitle ? null : this.nextTitleObservationSequence()
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
      if (agentStatus === 'idle' && prevStatus !== 'idle') {
        this.resolveTuiIdleWaiters(leaf)
      }
      // Why the second condition: push delivery is gated on LIVE idle, so its
      // authorizing edge is liveness as well as status. A restore seed or a
      // status kept across a same-id respawn leaves a stale 'idle' behind, and
      // an agent whose first live title is already idle (claude --resume at its
      // prompt) then shows no transition — the row would strand, which is
      // exactly #12536. Waiter semantics stay transition-only above.
      if (agentStatus === 'idle' && (prevStatus !== 'idle' || !prevObservedLive)) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }
    return ptyRecordChanged
  }

  /** Cancel the per-PTY title tracker (stale-title timer included) on PTY
   *  teardown so it cannot fire into pruned records. */
  protected disposePtyTitleTracker(ptyId: string): void {
    this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.dispose()
    this.ptyTitleTrackersByPtyId.delete(ptyId)
    this.ptyForegroundAgent.clearDelayedSnapshot(ptyId)
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
    this.ompPromptReadinessByPtyId.delete(ptyId)
    this.agentPromptPermissionSequenceByPtyId.delete(ptyId)
    this.agentPromptTerminalWorkingSequenceByPtyId.delete(ptyId)
    this.agentPromptTerminalEvidenceCarryByPtyId.delete(ptyId)
    this.agentPromptAcceptedGenerationByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.lastOscTitle = null
      pty.lastOscTitleAt = null
      pty.lastOscTitleEpochMs = null
      pty.lastAgentStatus = null
      // Why: the prior process's live frames say nothing about the replacement,
      // so the seed a same-id restore applies must not inherit its authority.
      pty.lastAgentStatusObservedLive = false
      pty.lastAgentStatusStartedAtEpochMs = null
      pty.lastAgentStatusRichInvalidatedAtEpochMs = Date.now()
      pty.managementTitle = null
      pty.managementTitleAt = null
      pty.waitBlockedAt = null
      pty.tailWaitState = undefined
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.lastOscTitle = null
      leaf.lastOscTitleAt = null
      leaf.lastAgentStatus = null
      leaf.lastAgentStatusObservedLive = false
      leaf.waitBlockedAt = null
      leaf.tailWaitState = undefined
    }
    this.primeWaitBlockedBaselineFromSeededTail(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)
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
