import { attachPtyOwnershipTransferDestination } from './pty-ownership-transfer-destination-attachment'
import { assertTransferIdentity } from './pty-ownership-transfer-response-identity'
import { randomUUID } from 'node:crypto'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferCommitReceipt } from '../../../shared/pty-ownership-transfer-journal-contract'
import {
  samePtyOwnershipTransferCommitReceipt,
  samePtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-receipt-validation'
import {
  PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
  type PtyOwnershipTransferSurfacePublication
} from '../../../shared/pty-ownership-transfer-surface-publication'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferPrepareResult
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferRequestOptions } from '../../providers/ssh-pty-ownership-transfer-client'
import { recoverPtyOwnershipTransfer } from './pty-ownership-transfer-recovery'
import type {
  PtyOwnershipTransferCoordinatorOptions,
  PtyOwnershipTransferCoordinatorResult,
  PtyOwnershipTransferRecoveryResult
} from './pty-ownership-transfer-coordinator-contract'

export type {
  PtyOwnershipTransferCoordinatorOptions,
  PtyOwnershipTransferCoordinatorResult,
  PtyOwnershipTransferRecoveryResult,
  PtyOwnershipTransferSource
} from './pty-ownership-transfer-coordinator-contract'

const DEFAULT_MAX_REPLAY_PASSES = 8

/** Executes the lossless source-fence and destination-publication transaction.
 *
 * This is intentionally transport-agnostic: callers provide the source RPC client and the
 * profile-scoped destination registry. It is safe to construct before the live-transfer feature
 * gate is enabled, and leaves the source fenced whenever commit state becomes ambiguous.
 */
export class PtyOwnershipTransferCoordinator {
  constructor(private readonly options: PtyOwnershipTransferCoordinatorOptions) {}

  async transfer(): Promise<PtyOwnershipTransferCoordinatorResult> {
    const request = this.prepareRequest()
    const requestOptions = this.requestOptions()
    let prepared: PtyOwnershipTransferPrepareResult | null = null
    let destination: PtyOwnershipTransferDestinationAdapter | null = null
    let destinationCommitted = false
    let sourceCommitted = false
    let disposeDestinationExit: (() => void) | undefined
    let disposeDestinationTransportLost: (() => void) | undefined
    let destinationStreamLost = (): boolean => false

    try {
      const destinationCapabilities = await this.resolveDestinationCapabilities(requestOptions)
      prepared = await this.options.source.prepare(request, requestOptions)
      assertTransferIdentity(prepared, this.options.identity)
      // The current destination surface publisher requires a complete stream beginning at
      // sequence 1. Refuse a pruned replay window before staging or committing anything; a
      // terminal-model baseline will remove this guard when it is wired into the registry.
      if (prepared.replayStartSeq !== 1) {
        throw new Error('pty_ownership_transfer_baseline_unavailable')
      }
      destination = this.options.destination.prepare(prepared).adapter
      destination.bindSurface(this.options.surfaceBinding)
      const attachment = await attachPtyOwnershipTransferDestination(
        this.options,
        destination,
        destinationCapabilities,
        requestOptions
      )
      disposeDestinationExit = attachment?.disposeExit
      disposeDestinationTransportLost = attachment?.disposeTransportLost
      destinationStreamLost = attachment?.isTransportLost ?? (() => false)

      const sourceEndSeq = await this.replayUntilCaughtUp(destination, prepared, requestOptions)
      if (destinationStreamLost()) {
        throw new Error('pty_ownership_transfer_destination_stream_unverifiable')
      }
      const commitReceipt = this.createCommitReceipt(sourceEndSeq)
      destination.commit(commitReceipt)
      destinationCommitted = true

      const committed = await this.options.source.commit(
        {
          ...this.options.identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          acceptedSourceEndSeq: sourceEndSeq,
          receipt: commitReceipt
        },
        requestOptions
      )
      assertTransferIdentity(committed, this.options.identity)
      if (!samePtyOwnershipTransferCommitReceipt(committed.receipt, commitReceipt)) {
        throw new Error('pty_ownership_transfer_commit_receipt_mismatch')
      }
      sourceCommitted = true

      if (destinationStreamLost()) {
        throw new Error('pty_ownership_transfer_destination_stream_unverifiable')
      }
      const publicationReceipt = destination.publish()
      const published = await this.options.source.publish(
        {
          ...this.options.identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          publicationReceipt
        },
        requestOptions
      )
      assertTransferIdentity(published, this.options.identity)
      if (
        !samePtyOwnershipTransferPublicationReceipt(
          published.publicationReceipt,
          publicationReceipt
        )
      ) {
        throw new Error('pty_ownership_transfer_publication_receipt_mismatch')
      }

      return Object.freeze({
        identity: this.options.identity,
        commitReceipt,
        publicationReceipt,
        destination
      })
    } catch (error) {
      disposeDestinationExit?.()
      disposeDestinationTransportLost?.()
      await this.rollbackAfterFailure({
        prepared,
        destination,
        destinationCommitted,
        sourceCommitted,
        requestOptions
      })
      throw error
    }
  }

  /**
   * Reconcile a transfer after an ambiguous network response. Prepared-only transfers are not
   * replayed here: callers must start a fresh bounded transfer while the source remains fenced.
   */
  async recover(): Promise<PtyOwnershipTransferRecoveryResult> {
    return recoverPtyOwnershipTransfer(this.options)
  }

  private async replayUntilCaughtUp(
    destination: PtyOwnershipTransferDestinationAdapter,
    prepared: PtyOwnershipTransferPrepareResult,
    requestOptions: PtyOwnershipTransferRequestOptions
  ): Promise<number> {
    let afterSeq = Math.max(0, prepared.replayStartSeq - 1)
    const maxPasses = positiveBound(this.options.maxReplayPasses ?? DEFAULT_MAX_REPLAY_PASSES)
    for (let pass = 0; pass < maxPasses; pass++) {
      const replay = await this.options.source.replay(
        {
          ...this.options.identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          afterSeq
        },
        requestOptions
      )
      destination.acceptReplay(replay)
      if (replay.sourceOutputEndSeq === afterSeq) {
        return replay.sourceOutputEndSeq
      }
      afterSeq = replay.sourceOutputEndSeq
    }
    throw new Error('pty_ownership_transfer_replay_did_not_quiesce')
  }

  private prepareRequest(): PtyOwnershipTransferPrepareRequest {
    const surfacePublication: PtyOwnershipTransferSurfacePublication = {
      version: PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
      surfaceBinding: this.options.surfaceBinding
    }
    return Object.freeze({
      ...this.options.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      surfacePublication
    })
  }

  private async resolveDestinationCapabilities(
    requestOptions: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipBridgeCapabilities | null | undefined> {
    return this.options.getDestinationCapabilities
      ? await this.options.getDestinationCapabilities(requestOptions)
      : this.options.destinationCapabilities
  }

  private createCommitReceipt(acceptedSourceEndSeq: number): PtyOwnershipTransferCommitReceipt {
    return {
      receiptId: (this.options.createReceiptId ?? randomUUID)(),
      bridgeId: this.options.identity.bridgeId,
      acceptedSourceEndSeq,
      committedAt: (this.options.now ?? (() => new Date()))().toISOString()
    }
  }

  private requestOptions(): PtyOwnershipTransferRequestOptions {
    return {
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs })
    }
  }

  private async rollbackAfterFailure(args: {
    prepared: PtyOwnershipTransferPrepareResult | null
    destination: PtyOwnershipTransferDestinationAdapter | null
    destinationCommitted: boolean
    sourceCommitted: boolean
    requestOptions: PtyOwnershipTransferRequestOptions
  }): Promise<void> {
    if (!args.prepared || args.sourceCommitted || args.destinationCommitted) {
      return
    }
    let destinationRolledBack = args.destination === null
    if (args.destination && !args.destinationCommitted) {
      try {
        args.destination.abort()
        destinationRolledBack = true
      } catch {
        // Keep the source fence when destination rollback is not provable.
      }
    }
    if (!destinationRolledBack) {
      return
    }
    try {
      await this.options.source.abort(
        { ...this.options.identity, version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION },
        args.requestOptions
      )
    } catch {
      // Loss of contact is unverifiable; the source must remain fenced for recovery.
    }
  }
}

function positiveBound(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 128) {
    throw new Error('pty_ownership_transfer_replay_pass_bound_invalid')
  }
  return value
}
