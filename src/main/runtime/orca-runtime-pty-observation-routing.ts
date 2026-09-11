import { OrcaRuntimeWithGetPtyRecordForPaneKey } from './orca-runtime-get-pty-record-for-pane-key'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'
import { parseFileUriPathParts } from '../daemon/osc7-file-uri'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyTransientFact } from '../providers/types'
import {
  MAX_PENDING_PTY_OBSERVATION_SOURCES,
  ptyObservationSourceKey,
  type PtyObservationStamp
} from './runtime-pty-observation-admission'
import {
  createRuntimePtyObservationCapsule,
  observePtyObservationChunk,
  observePtyObservationTransientFact,
  resetPtyObservationParseCarry,
  type PendingPtyObservationAdmission,
  type PtyObservationCapsuleHooks,
  type RuntimePtyObservationCapsule
} from './runtime-pty-observation-capsule'

/**
 * Observation-source selection and capsule ingestion. Owns the candidate store
 * and the pending-admission bookkeeping; `OrcaRuntimeWithPtyObservationAdmission`
 * owns the admission lifetime and promotion that act on them.
 */
export class OrcaRuntimeWithPtyObservationRouting extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  /** Candidate parser capsules, keyed by PTY id then by observation source. */
  protected ptyObservationCapsulesByPtyId = new Map<
    string,
    Map<string, RuntimePtyObservationCapsule>
  >()
  /** The source whose automatic evidence currently owns each PTY id. `null` means a legacy untagged stream. */
  protected admittedPtyObservationSourceByPtyId = new Map<string, PtyIncarnationId | null>()
  protected pendingPtyObservationAdmissionsByToken = new Map<
    string,
    PendingPtyObservationAdmission
  >()
  protected pendingPtyObservationAdmissionTokensByPtyId = new Map<string, string>()
  /** Provider-generation resets held back out of the pre-commit path until admission settles. */
  protected deferredPtyObservationGenerationResets = new Set<string>()
  /** Incarnations a proven replacement retired restored-scrollback seeding for. */
  protected retiredRestoreSeedIncarnationByPtyId = new Map<string, PtyIncarnationId>()
  protected nextPtyObservationIngestionOrdinal = 1
  /** Per-chunk observation counter: orders a title against a command-finished inside one chunk. */
  private nextPtyObservationChunkOrder = 0

  protected hasPendingPtyObservationAdmission(ptyId: string): boolean {
    return this.pendingPtyObservationAdmissionTokensByPtyId.has(ptyId)
  }

  // ---- source selection, before parsing ----

  /**
   * Divert to a capsule only for a known source that differs from the PTY's
   * currently admitted source while its admission is still pending. Legacy
   * untagged streams, first-seen sources and same-source attaches keep the
   * ordinary live path.
   */
  protected resolvePtyObservationCapsule(
    ptyId: string,
    incarnationId?: PtyIncarnationId
  ): RuntimePtyObservationCapsule | null {
    if (incarnationId === undefined || !this.hasPendingPtyObservationAdmission(ptyId)) {
      return null
    }
    const admitted = this.admittedPtyObservationSourceByPtyId.get(ptyId)
    if (admitted === undefined || admitted === null || admitted === incarnationId) {
      return null
    }
    return this.getOrCreatePtyObservationCapsule(ptyId, incarnationId)
  }

  /** True when the live path may adopt this source as the PTY's accepted one. */
  protected canSeedAdmittedPtyObservationSource(ptyId: string): boolean {
    return !this.hasPendingPtyObservationAdmission(ptyId)
  }

  /**
   * Capsule budget exhausted for a divertable source: its automatic evidence is
   * refused outright rather than leaked onto the accepted state, and the
   * matching admission preflight then fails closed.
   */
  protected shouldWithholdUnadmittedPtyObservation(
    ptyId: string,
    incarnationId?: PtyIncarnationId
  ): boolean {
    if (incarnationId === undefined) {
      return false
    }
    const token = this.pendingPtyObservationAdmissionTokensByPtyId.get(ptyId)
    const admission = token ? this.pendingPtyObservationAdmissionsByToken.get(token) : undefined
    if (!admission?.overflowed) {
      return false
    }
    const admitted = this.admittedPtyObservationSourceByPtyId.get(ptyId)
    return admitted !== undefined && admitted !== null && admitted !== incarnationId
  }

  private getOrCreatePtyObservationCapsule(
    ptyId: string,
    incarnationId: PtyIncarnationId
  ): RuntimePtyObservationCapsule | null {
    let capsules = this.ptyObservationCapsulesByPtyId.get(ptyId)
    if (!capsules) {
      capsules = new Map()
      this.ptyObservationCapsulesByPtyId.set(ptyId, capsules)
    }
    const key = ptyObservationSourceKey(incarnationId)
    const existing = capsules.get(key)
    if (existing) {
      return existing
    }
    if (capsules.size >= MAX_PENDING_PTY_OBSERVATION_SOURCES) {
      // Fail closed: refuse the evidence now and the admission later, instead of
      // evicting a candidate or growing past the audited retry bound.
      const token = this.pendingPtyObservationAdmissionTokensByPtyId.get(ptyId)
      const admission = token ? this.pendingPtyObservationAdmissionsByToken.get(token) : undefined
      if (admission) {
        admission.overflowed = true
      }
      return null
    }
    const capsule = createRuntimePtyObservationCapsule(
      { ptyId, incarnationId },
      this.ptyObservationCapsuleHooks
    )
    capsules.set(key, capsule)
    return capsule
  }

  private get ptyObservationCapsuleHooks(): PtyObservationCapsuleHooks {
    return {
      isIdentityOnlyTitle: (rawTitle: string, meta?: TerminalTitleFactMeta): boolean =>
        this.isLiveCursorNativeTitle(rawTitle, meta),
      nextStamp: (): PtyObservationStamp => ({
        ingestionOrdinal: this.nextPtyObservationIngestionOrdinal,
        chunkOrder: this.nextPtyObservationChunkOrder++,
        observedAtEpochMs: Date.now()
      }),
      resolveOsc7Path: (ptyId: string, uri: string): string | null => {
        const pty = this.ptysById.get(ptyId)
        return (
          parseFileUriPathParts(uri, {
            pathFlavor: this.pathFlavorForPty(pty),
            remotePosixAuthority: !!pty?.connectionId
          })?.path ?? null
        )
      }
    }
  }

  // ---- capsule ingestion ----

  protected observePtyAutomaticData(capsule: RuntimePtyObservationCapsule, data: string): void {
    this.nextPtyObservationIngestionOrdinal += 1
    this.nextPtyObservationChunkOrder = 0
    observePtyObservationChunk(capsule, data, this.ptyObservationCapsuleHooks)
  }

  protected resetPtyObservationParseCarry(capsule: RuntimePtyObservationCapsule): void {
    resetPtyObservationParseCarry(capsule)
  }

  protected observePtyObservationTransientFact(
    capsule: RuntimePtyObservationCapsule,
    fact: PtyTransientFact
  ): void {
    this.nextPtyObservationIngestionOrdinal += 1
    this.nextPtyObservationChunkOrder = 0
    observePtyObservationTransientFact(capsule, fact, this.ptyObservationCapsuleHooks)
  }
}
