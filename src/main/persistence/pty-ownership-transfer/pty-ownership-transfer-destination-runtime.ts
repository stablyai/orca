import {
  PtyOwnershipTransferDestinationAdapter,
  PtyOwnershipTransferDestinationError,
  type PtyOwnershipTransferDestinationAttachmentReservation
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import { PtyOwnershipTransferDestinationAdmission } from './pty-ownership-transfer-destination-admission'
import type {
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferExitEvent
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { PtyOwnershipTransferDestinationOutputAdmission } from './pty-ownership-transfer-destination-output-admission'
import { PtyOwnershipTransferDestinationExitAdmission } from './pty-ownership-transfer-destination-exit-admission'
import type { PtyOwnershipTransferDestinationOutputSink } from './pty-ownership-transfer-destination-output-sink'
import { createPtyOwnershipTransferRuntimePersistence } from './pty-ownership-transfer-runtime-persistence'
import type { PtyOwnershipTransferOutputModelCheckpoint } from './pty-ownership-transfer-destination-output-outbox-record'
import { PtyOwnershipTransferSurfacePublicationCoordinator } from './pty-ownership-transfer-surface-publication'
import type { PtyOwnershipTransferDestinationRecoveryCandidate } from './pty-ownership-transfer-destination-recovery-candidates'
import {
  recoverPersistedPtyOwnershipAdapters,
  recoverPersistedDelegatedPtyDestinations,
  readPublishedDelegatedPtyDestination,
  loadActivePtyOwnershipOutput,
  type RecoverPtyOwnershipRetirement
} from './pty-ownership-transfer-runtime-recovery'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import { prepareDelegatedPtyOwnershipDestination } from './pty-ownership-transfer-delegated-preparation'
import {
  prepareCapturedPtyOwnershipDestination,
  type CapturedPtyOwnershipDestinationRequest
} from './pty-ownership-transfer-captured-preparation'
import { restorePtyOwnershipModelProjection } from './pty-ownership-transfer-model-projection-recovery'
import {
  watchPtyOwnershipTransferDestinationExit,
  type PtyOwnershipTransferDestinationExitSource
} from './pty-ownership-transfer-destination-exit-watch'
import {
  watchPtyOwnershipTransferDestinationOutput,
  type PtyOwnershipTransferDestinationOutputSource
} from './pty-ownership-transfer-destination-output-watch'

import {
  PtyOwnershipTransferWorkspaceSurfaceTarget,
  type PtyOwnershipTransferDestinationRuntimeOptions
} from './pty-ownership-transfer-destination-runtime-contract'
export * from './pty-ownership-transfer-destination-runtime-contract'

export class PtyOwnershipTransferDestinationRuntimeRegistry extends PtyOwnershipTransferDestinationAdmission {
  private readonly adapters = new Map<string, PtyOwnershipTransferDestinationAdapter>()
  private readonly exitListeners = new Map<string, () => void>()
  protected readonly destinationStore: PtyOwnershipTransferDestinationFileStore
  protected readonly outputOutbox: PtyOwnershipTransferDestinationOutputOutbox
  private readonly outputSink: PtyOwnershipTransferDestinationOutputSink
  private readonly outputAdmission = new PtyOwnershipTransferDestinationOutputAdmission()
  private readonly exitAdmission = new PtyOwnershipTransferDestinationExitAdmission()
  private readonly publication: PtyOwnershipTransferSurfacePublicationCoordinator

  constructor(private readonly options: PtyOwnershipTransferDestinationRuntimeOptions) {
    super(options.runtimeId, options.store.getProfileStorageDirectory())
    const persistence = createPtyOwnershipTransferRuntimePersistence(options)
    this.destinationStore = persistence.destinationStore
    this.outputOutbox = persistence.outputOutbox
    this.outputSink = persistence.outputSink
    this.publication = new PtyOwnershipTransferSurfacePublicationCoordinator(
      new PtyOwnershipTransferWorkspaceSurfaceTarget(options.store),
      (identity) =>
        this.getDelegatedModelOutbox(identity)?.loadInitialModelSnapshot(identity) ?? null
    )
  }

  prepare(result: PtyOwnershipTransferPrepareResult) {
    this.assertDestinationAdmissionOpen()
    if (result.destinationRuntimeId !== this.options.runtimeId) {
      throw new Error('pty_ownership_transfer_destination_runtime_mismatch')
    }
    // Retries retain the original baseline even when the fenced source reports a newer cursor.
    const outputSnapshot = loadActivePtyOwnershipOutput(this.outputOutbox, result)
    if (!outputSnapshot) {
      this.outputSink.open(result, result.sourceOutputEndSeq)
    }
    let adapter = this.adapters.get(result.bridgeId)
    if (!adapter) {
      adapter = new PtyOwnershipTransferDestinationAdapter({
        store: this.destinationStore,
        publishDurably: (request) => this.publication.publish(request),
        publishPostCommitOutput: (identity, surfaceBinding, frame) =>
          this.outputSink.publish(identity, surfaceBinding, frame),
        markPostCommitOutputBaseline: (identity, throughSeq) =>
          this.outputSink.markCommittedThrough(identity, throughSeq),
        ...(this.options.inputIds === undefined ? {} : { inputIds: this.options.inputIds })
      })
      this.adapters.set(result.bridgeId, adapter)
    }
    const snapshot = adapter.prepare(result)
    if (outputSnapshot && (snapshot.phase === 'committed' || snapshot.phase === 'published')) {
      adapter.restorePostCommitOutputBaseline(outputSnapshot.acknowledgedEndSeq)
    }
    restorePtyOwnershipModelProjection(adapter.snapshot(), this.outputOutbox, this.options.store)
    return Object.freeze({ adapter, snapshot: adapter.snapshot() })
  }

  get(bridgeId: string): PtyOwnershipTransferDestinationAdapter | null {
    return this.adapters.get(bridgeId) ?? null
  }

  getDelegatedModelOutbox(identity: PtyOwnershipTransferWireIdentity) {
    this.requireAdapter(identity)
    return this.destinationStore.loadDelegatedSource(identity) ? this.outputOutbox : null
  }

  /** Delegated streams stage initial replay in the same outbox as later model delivery. */
  prepareDelegated(result: PtyOwnershipTransferPrepareResult, source: unknown) {
    this.assertDestinationAdmissionOpen()
    return prepareDelegatedPtyOwnershipDestination(result, source, {
      runtimeId: this.options.runtimeId,
      strictAcknowledgements: !!this.options.publishPostCommitOutputAcknowledged,
      destinationStore: this.destinationStore,
      outputOutbox: this.outputOutbox,
      prepare: (result) => this.prepare(result)
    })
  }

  prepareCapturedDelegated(request: CapturedPtyOwnershipDestinationRequest) {
    return prepareCapturedPtyOwnershipDestination(request, {
      runtimeId: this.options.runtimeId,
      destinationStore: this.destinationStore,
      catalogStore: this.options.store,
      assertActive: () => this.assertDestinationAdmissionOpen(),
      prepare: (result, source) => this.prepareDelegated(result, source)
    })
  }

  getPublishedDelegatedDestination(identity: PtyOwnershipTransferWireIdentity) {
    return readPublishedDelegatedPtyDestination(
      this.requireAdapter(identity),
      this.destinationStore,
      this.outputOutbox
    )
  }

  /** Discover interrupted sessions at startup without contacting or mutating their source. */
  listRecoveryCandidates(): readonly PtyOwnershipTransferDestinationRecoveryCandidate[] {
    return this.destinationStore.listRecoveryCandidates()
  }

  /** Reopen durable sessions for this runtime without contacting their source host. */
  recoverPersistedAdapters() {
    return recoverPersistedPtyOwnershipAdapters({
      runtimeId: this.options.runtimeId,
      candidates: this.listRecoveryCandidates(),
      prepare: (result) => this.prepare(result)
    })
  }

  recoverPersistedDelegatedDestinations(recoverRetirement?: RecoverPtyOwnershipRetirement) {
    return recoverPersistedDelegatedPtyDestinations({
      runtimeId: this.options.runtimeId,
      candidates: this.listRecoveryCandidates(),
      strictAcknowledgements: !!this.options.publishPostCommitOutputAcknowledged,
      destinationStore: this.destinationStore,
      outputOutbox: this.outputOutbox,
      recoverRetirement,
      prepare: (result) => this.prepare(result)
    })
  }

  /** Keep authoritative source exit evidence attached to the exact destination adapter. */
  watchDestinationExit(
    source: PtyOwnershipTransferDestinationExitSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return this.watchDestinationExitForAttachment(
      source,
      capabilities,
      adapter.snapshot().identity,
      adapter.snapshot().attachmentId ?? '',
      adapter,
      reservation
    )
  }

  watchDestinationExitForAttachment(
    source: PtyOwnershipTransferDestinationExitSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return watchPtyOwnershipTransferDestinationExit(
      source,
      capabilities,
      identity,
      attachmentId,
      adapter,
      reservation,
      this.exitAdmission,
      this.exitListeners
    )
  }

  /** Keep a paired source output stream bound to the exact attachment reservation. */
  watchDestinationOutput(
    source: PtyOwnershipTransferDestinationOutputSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return watchPtyOwnershipTransferDestinationOutput(
      source,
      capabilities,
      identity,
      attachmentId,
      adapter,
      reservation
        ? (eventIdentity, frame) => this.acceptPostCommitOutputAfterAttachment(eventIdentity, frame)
        : undefined
    )
  }

  pendingPostCommitOutput(identity: PtyOwnershipTransferWireIdentity) {
    return this.outputOutbox.load(identity)
  }

  stagePostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): void {
    const snapshot = this.requireAdapter(identity).snapshot()
    if (snapshot.phase !== 'committed' && snapshot.phase !== 'published') {
      throw new Error('pty_ownership_transfer_destination_output_unavailable')
    }
    if (!snapshot.surfaceBinding) {
      throw new Error('pty_ownership_transfer_destination_surface_unbound')
    }
    this.outputSink.stage(identity, frame)
  }

  /** Persist the exact model fragment that made a post-commit frame safe to acknowledge. */
  recordModelCheckpoint(
    identity: PtyOwnershipTransferWireIdentity,
    checkpoint: PtyOwnershipTransferOutputModelCheckpoint
  ): void {
    const snapshot = this.requireAdapter(identity).snapshot()
    if (snapshot.phase !== 'committed' && snapshot.phase !== 'published') {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    this.outputOutbox.recordModelCheckpoint(identity, checkpoint)
  }

  loadModelCheckpoints(
    identity: PtyOwnershipTransferWireIdentity
  ): readonly PtyOwnershipTransferOutputModelCheckpoint[] {
    return this.outputOutbox.loadModelCheckpoints(identity)
  }

  acceptPostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): void {
    this.requireAdapter(identity).acceptPostCommitOutput(frame)
  }

  /** Wait for recovery's attachment barrier without releasing this frame's source credit. */
  async acceptPostCommitOutputAfterAttachment(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): Promise<void> {
    try {
      this.acceptPostCommitOutput(identity, frame)
    } catch (error) {
      if (
        !(error instanceof PtyOwnershipTransferDestinationError) ||
        error.reason !== 'stale-attachment'
      ) {
        throw error
      }
      await this.outputAdmission.defer(identity, frame)
    }
  }

  /** Apply a relay attachment result to the exact durable destination adapter. */
  acceptDestinationAttachment(
    result: PtyOwnershipTransferAttachmentResult,
    reservation: PtyOwnershipTransferDestinationAttachmentReservation
  ): ReturnType<PtyOwnershipTransferDestinationAdapter['attachExecution']> {
    const adapter = this.requireAdapter(result)
    adapter.attachExecution(result, reservation)
    this.exitAdmission.settle(reservation, adapter)
    this.outputAdmission.settle(result, (frame) => adapter.acceptPostCommitOutput(frame))
    return adapter.snapshot()
  }

  rejectPendingPostCommitOutputAdmission(
    identity: PtyOwnershipTransferWireIdentity,
    error: unknown
  ): void {
    this.outputAdmission.reject(identity, error)
  }

  acceptDestinationExit(
    event: PtyOwnershipTransferExitEvent
  ): ReturnType<PtyOwnershipTransferDestinationAdapter['acceptExit']> {
    return this.requireAdapter(event).acceptExit(event)
  }

  /** Replay queued frames through the same idempotent sink used for live output. */
  replayPendingPostCommitOutput(identity: PtyOwnershipTransferWireIdentity): number {
    const adapter = this.requireAdapter(identity)
    const pending = this.outputOutbox.load(identity)?.pendingFrames ?? []
    for (const frame of pending) {
      adapter.acceptPostCommitOutput(frame)
    }
    return pending.length
  }

  private requireAdapter(identity: PtyOwnershipTransferWireIdentity) {
    const adapter = this.adapters.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    if (!samePtyOwnershipTransferIdentity(adapter.snapshot().identity, identity)) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    return adapter
  }
}
