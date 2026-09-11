import { OrcaRuntimeWithPtyReplacementDurableRetirement } from './runtime-pty-replacement-durable-retirement'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { applyPromotedPtyObservationTitle } from './runtime-pty-observation-promotion'
import {
  pendingPtyObservationSummaryIsEmpty,
  ptyObservationSourceKey,
  PtyObservationCapacityError,
  type PendingPtyObservationSummary
} from './runtime-pty-observation-admission'
import {
  installPromotedPtyObservationCapsule,
  type PreparedPtyObservationAdmission
} from './runtime-pty-observation-capsule'

export class OrcaRuntimeWithPtyObservationAdmission extends OrcaRuntimeWithPtyReplacementDurableRetirement {
  private nextPtyObservationAdmissionToken = 1

  // ---- admission lifetime (owned by the existing spawn registration lifetime) ----

  beginPtyObservationAdmission(ptyId: string): string {
    const existingToken = this.pendingPtyObservationAdmissionTokensByPtyId.get(ptyId)
    if (existingToken) {
      // Concurrent spawns for one pane share the audited candidate budget rather than doubling it.
      return existingToken
    }
    const token = `pty-observation-admission-${this.nextPtyObservationAdmissionToken++}`
    this.pendingPtyObservationAdmissionsByToken.set(token, { token, ptyId, overflowed: false })
    this.pendingPtyObservationAdmissionTokensByPtyId.set(ptyId, token)
    return token
  }

  /** Daemon claim adoption rewrites the requested PTY id to the canonical owner after the control reply. */
  transferPtyObservationAdmission(token: string | null, toPtyId: string): string | null {
    if (!token) {
      return null
    }
    const admission = this.pendingPtyObservationAdmissionsByToken.get(token)
    if (!admission || admission.ptyId === toPtyId) {
      return token
    }
    this.releasePtyObservationCandidates(admission.ptyId)
    this.pendingPtyObservationAdmissionTokensByPtyId.delete(admission.ptyId)
    this.deferredPtyObservationGenerationResets.delete(admission.ptyId)
    const existingToken = this.pendingPtyObservationAdmissionTokensByPtyId.get(toPtyId)
    if (existingToken && existingToken !== token) {
      // The canonical id already has an owner: this token is dead, so drop it
      // rather than leaving an unreachable entry the per-PTY reaper never sees.
      this.pendingPtyObservationAdmissionsByToken.delete(token)
      return existingToken
    }
    admission.ptyId = toPtyId
    admission.overflowed = false
    this.pendingPtyObservationAdmissionTokensByPtyId.set(toPtyId, token)
    return token
  }

  cancelPtyObservationAdmission(token: string | null | undefined): void {
    if (!token) {
      return
    }
    const admission = this.pendingPtyObservationAdmissionsByToken.get(token)
    if (!admission) {
      return
    }
    this.forgetPtyObservationAdmissionToken(token, admission.ptyId)
    // Accepted state survives: candidates and their held-back reset are dropped, never applied.
    this.releasePtyObservationCandidates(admission.ptyId)
    this.deferredPtyObservationGenerationResets.delete(admission.ptyId)
  }

  private forgetPtyObservationAdmissionToken(token: string, ptyId: string): void {
    this.pendingPtyObservationAdmissionsByToken.delete(token)
    if (this.pendingPtyObservationAdmissionTokensByPtyId.get(ptyId) === token) {
      this.pendingPtyObservationAdmissionTokensByPtyId.delete(ptyId)
    }
  }

  /**
   * Validate operation ownership and capacity before the caller mutates any
   * binding. Throws only on overflow, which the outer spawn wrapper turns into
   * a non-destructive cancellation.
   */
  preparePtyObservationAdmission(
    token: string | null | undefined,
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    surface?: { worktreeId: string; tabId: string; leafId: string }
  ): PreparedPtyObservationAdmission | null {
    if (!token) {
      return null
    }
    const admission = this.pendingPtyObservationAdmissionsByToken.get(token)
    if (!admission || admission.ptyId !== ptyId) {
      // Duplicate or stale token: no promotion, no mutation.
      return null
    }
    if (admission.overflowed) {
      throw new PtyObservationCapacityError(ptyId)
    }
    const capsules = this.ptyObservationCapsulesByPtyId.get(ptyId)
    const capsule = capsules?.get(ptyObservationSourceKey(incarnationId)) ?? null
    const persistedIncarnationId = surface
      ? this.readKnownPredecessorPaneIncarnationForPty(ptyId, surface)
      : null
    return {
      token,
      ptyId,
      ...(incarnationId === undefined ? {} : { incarnationId }),
      ...(surface ? { surface } : {}),
      ...(persistedIncarnationId === null ? {} : { persistedIncarnationId }),
      capsule: capsule && !pendingPtyObservationSummaryIsEmpty(capsule.summary) ? capsule : null
    }
  }

  /**
   * Promote at most one candidate. The caller must already have completed
   * binding persistence and final registration, and must not yet have run the
   * registration publication tail. Returns the retired predecessor incarnation
   * when this admission is positive known-old → known-new proof.
   */
  acceptPtyObservationAdmission(
    prepared: PreparedPtyObservationAdmission | null
  ): PtyIncarnationId | null {
    if (!prepared) {
      return null
    }
    const admission = this.pendingPtyObservationAdmissionsByToken.get(prepared.token)
    if (!admission || admission.ptyId !== prepared.ptyId) {
      return null
    }
    const { ptyId, capsule } = prepared
    const liveAdmitted = this.admittedPtyObservationSourceByPtyId.get(ptyId)
    // Why the persisted fallback: a relaunched host holds no live predecessor, so the pane's
    // durable binding is its only known-old. Live evidence still outranks it.
    const previouslyAdmitted =
      liveAdmitted === undefined || liveAdmitted === null
        ? (prepared.persistedIncarnationId ?? null)
        : liveAdmitted
    // Why capsule-independent: the replacement proof is the known-old → known-new
    // incarnation transition. A candidate is what may be PROMOTED, not what makes the
    // predecessor's evidence stale.
    const replacedIncarnationId =
      prepared.incarnationId !== undefined &&
      previouslyAdmitted !== null &&
      previouslyAdmitted !== prepared.incarnationId
        ? previouslyAdmitted
        : null
    if (replacedIncarnationId !== null) {
      // Retire predecessor runtime automatic applicability first, then apply the
      // winning capsule — so an early successor title identical to the
      // predecessor's survives the retirement.
      this.resetTrackedTerminalStateForProviderGeneration(ptyId)
      this.deferredPtyObservationGenerationResets.delete(ptyId)
      if (capsule) {
        installPromotedPtyObservationCapsule(
          ptyId,
          capsule,
          {
            titleTrackers: this.ptyTitleTrackersByPtyId,
            agentStatusProcessors: this.agentStatusOscProcessorsByPtyId,
            oscTitleScanTails: this.oscTitleScanTailByPtyId,
            osc7ScanTails: this.osc7ScanTailByPtyId
          },
          {
            enabled: this.terminalSideEffectConsumerAvailable,
            createCommandCodeDetector: () => this.createTerminalSideEffectCommandCodeDetector(ptyId)
          },
          this.createLivePtyTitleTrackerCallbacks(ptyId, capsule.entry)
        )
        this.applyPromotedPtyObservationSummary(ptyId, capsule.summary)
      }
    } else if (this.deferredPtyObservationGenerationResets.delete(ptyId)) {
      this.resetTrackedTerminalStateForProviderGeneration(ptyId)
    }
    this.admittedPtyObservationSourceByPtyId.set(ptyId, prepared.incarnationId ?? null)
    this.releasePtyObservationCandidates(ptyId)
    this.forgetPtyObservationAdmissionToken(prepared.token, ptyId)
    return replacedIncarnationId
  }

  /** Record the accepted source without promoting anything (live seeding). */
  protected noteAdmittedPtyObservationSource(
    ptyId: string,
    incarnationId?: PtyIncarnationId
  ): void {
    if (incarnationId === undefined) {
      return
    }
    this.admittedPtyObservationSourceByPtyId.set(ptyId, incarnationId)
  }

  /**
   * The registration-time source transition for a commit that prepared no admission.
   * Returns the retired predecessor incarnation on the same known-old → known-new proof the
   * admission uses; a missing incarnation on either side is never replacement. Unlike the
   * live seed above this runs at a commit boundary, so it may retire automatic state.
   */
  protected admitRegisteredPtyObservationSource(
    ptyId: string,
    incarnationId?: PtyIncarnationId
  ): PtyIncarnationId | null {
    if (incarnationId === undefined) {
      return null
    }
    const previouslyAdmitted = this.admittedPtyObservationSourceByPtyId.get(ptyId)
    this.admittedPtyObservationSourceByPtyId.set(ptyId, incarnationId)
    if (
      previouslyAdmitted === undefined ||
      previouslyAdmitted === null ||
      previouslyAdmitted === incarnationId
    ) {
      return null
    }
    this.resetTrackedTerminalStateForProviderGeneration(ptyId)
    this.deferredPtyObservationGenerationResets.delete(ptyId)
    return previouslyAdmitted
  }

  /**
   * The automatic-state half of the provider-generation reset. Held back while
   * an admission is pending so a pre-commit reset cannot discard evidence the
   * commit has not yet accepted; sequence/model bookkeeping still runs inline.
   */
  protected deferTrackedTerminalStateResetForProviderGeneration(ptyId: string): void {
    if (this.hasPendingPtyObservationAdmission(ptyId)) {
      this.deferredPtyObservationGenerationResets.add(ptyId)
      return
    }
    this.resetTrackedTerminalStateForProviderGeneration(ptyId)
  }

  // ---- promotion ----

  /**
   * State application, not event replay: records the promoted source's latest
   * title/status/CWD without resolving idle waiters, delivering queued
   * messages, confirming an agent exit or refreshing the foreground owner.
   */
  private applyPromotedPtyObservationSummary(
    ptyId: string,
    summary: PendingPtyObservationSummary
  ): void {
    if (summary.cwd) {
      this.terminalCwdByPtyId.set(ptyId, summary.cwd.value)
    }
    if (summary.title) {
      const agentStatus = applyPromotedPtyObservationTitle(
        summary.title.value,
        summary.title.stamp,
        {
          pty: this.ptysById.get(ptyId),
          leaves: this.getLeavesForPty(ptyId),
          nextTitleObservationSequence: () => this.nextTitleObservationSequence(),
          setManagementTitle: (pty, normalizedTitle, observedAt) =>
            this.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt)
        }
      )
      this.recordAgentPromptLifecycleState(ptyId, agentStatus)
    }
    if (summary.lifecycle?.value.kind === 'agent-status' && !summary.title) {
      this.recordAgentPromptLifecycleState(ptyId, summary.lifecycle.value.status)
    }
    if (summary.explicitStatus) {
      // Publish the promoted source's current explicit state through the existing
      // agent-status ingestion, so the registration tail below sees it.
      this.emitTerminalAgentStatusEvents(ptyId, {
        cleanData: '',
        payloads: [summary.explicitStatus.value],
        lastPayloadCleanOffset: null
      })
    }
  }

  // ---- disposal ----

  protected releasePtyObservationCandidates(ptyId: string): void {
    const capsules = this.ptyObservationCapsulesByPtyId.get(ptyId)
    if (!capsules) {
      return
    }
    const accepted = this.ptyTitleTrackersByPtyId.get(ptyId)
    for (const capsule of capsules.values()) {
      if (capsule.entry !== accepted) {
        capsule.entry.tracker.dispose()
      }
    }
    this.ptyObservationCapsulesByPtyId.delete(ptyId)
  }

  /**
   * PTY teardown. The pending admission token itself stays owned by the spawn
   * call that minted it, so its commit still resolves deterministically.
   * `preserveRestoreSeedFence` keeps the retired-scrollback identity fence: an
   * unreported SSH exit is loss of contact, not proof the process died, and the
   * pane keeps the predecessor's retained scrollback through the reconnect grace.
   * `preserveRetiredPaneEvidence` keeps the pane's retired-row fence for the same
   * reason: the unconfirmed successor still owns the pane, so the predecessor
   * remnant must stay unprojectable onto it.
   */
  protected disposePtyObservationState(
    ptyId: string,
    options: { preserveRestoreSeedFence?: boolean; preserveRetiredPaneEvidence?: boolean } = {}
  ): void {
    this.releasePtyObservationCandidates(ptyId)
    this.admittedPtyObservationSourceByPtyId.delete(ptyId)
    this.deferredPtyObservationGenerationResets.delete(ptyId)
    if (options.preserveRestoreSeedFence !== true) {
      this.retiredRestoreSeedIncarnationByPtyId.delete(ptyId)
    }
    this.forgetRetiredPtyRecordsForPty(ptyId, {
      preserveRetiredPaneEvidence: options.preserveRetiredPaneEvidence === true
    })
  }

  /** True while restored scrollback must not establish this PTY incarnation's identity. */
  protected hasRetiredPtyRestoreSeed(ptyId: string): boolean {
    const retired = this.retiredRestoreSeedIncarnationByPtyId.get(ptyId)
    return retired !== undefined && retired === this.ptysById.get(ptyId)?.incarnationId
  }
}
