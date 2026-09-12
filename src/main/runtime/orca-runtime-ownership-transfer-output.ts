import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import {
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import {
  createPtyOwnershipTransferDestinationRegistry,
  samePtyOwnershipTransferIdentity
} from './runtime-ownership-transfer-contracts'
import { OrcaRuntimeWithPairedOwnershipTransfer } from './orca-runtime-paired-ownership-transfer'

export class OrcaRuntimeWithOwnershipTransferOutput extends OrcaRuntimeWithPairedOwnershipTransfer {
  installPtyOwnershipTransferDestinationOutputBridge(
    options: { catalogPublicationVersion?: 1 } = {}
  ): boolean {
    if (this.ptyOwnershipTransferDestinationRegistry) {
      return (
        options.catalogPublicationVersion === undefined ||
        this.ptyOwnershipTransferDestinationRegistry.supportsCapturedCatalogPublication()
      )
    }
    const registry = createPtyOwnershipTransferDestinationRegistry(
      this.store,
      this.runtimeId,
      () => {},
      (identity, surfaceBinding, frame) =>
        this.acknowledgePtyOwnershipTransferPostCommitOutput(identity, surfaceBinding, frame),
      options.catalogPublicationVersion
    )
    if (!registry) {
      return false
    }
    this.ptyOwnershipTransferDestinationRegistry = registry
    try {
      registry.recoverPersistedAdapters()
    } catch (error) {
      // Keep malformed or prior-runtime journals durable; output remains unverifiable.
      console.warn('[pty-ownership-transfer] destination recovery hydration unavailable:', error)
    }
    return true
  }

  protected acknowledgePtyOwnershipTransferPostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity,
    surfaceBinding: PtyOwnershipTransferSurfaceBinding,
    frame: PtyOwnershipTransferOutputFrame
  ): { identity: PtyOwnershipTransferWireIdentity; throughSeq: number } {
    const registry = this.ptyOwnershipTransferDestinationRegistry
    if (!registry) {
      throw new Error('pty_ownership_transfer_destination_output_bridge_unavailable')
    }
    const adapter = registry.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (snapshot.phase !== 'committed' && snapshot.phase !== 'published') {
      throw new Error('pty_ownership_transfer_destination_output_unavailable')
    }
    if (
      !snapshot.surfaceBinding ||
      !samePtyOwnershipTransferIdentity(snapshot.identity, identity) ||
      !samePtyOwnershipTransferSurfaceBinding(snapshot.surfaceBinding, surfaceBinding)
    ) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
      },
      identity,
      surfaceBinding
    )
    let frameRecord = this.ptyOwnershipTransferModelCheckpointsByBridge
      .get(identity.bridgeId)
      ?.get(frame.seq)
    if (!frameRecord || registry.getDelegatedModelOutbox(identity)) {
      frameRecord = undefined
      const persisted = registry
        .loadModelCheckpoints(identity)
        .filter((checkpoint) => checkpoint.frameSeq === frame.seq)
      if (persisted.length > 0) {
        frameRecord = {
          identity: Object.freeze({ ...identity }),
          surfaceBinding: Object.freeze({ ...surfaceBinding }),
          ptyId: persisted[0].ptyId,
          frameLengthSu: persisted[0].frameLengthSu,
          fragments: new Map(
            persisted.map((checkpoint) => [
              checkpoint.fragmentStartSu,
              Object.freeze({
                identity: Object.freeze({ ...identity }),
                surfaceBinding: Object.freeze({ ...surfaceBinding }),
                ptyId: checkpoint.ptyId,
                frameSeq: checkpoint.frameSeq,
                fragmentStartSu: checkpoint.fragmentStartSu,
                fragmentEndSu: checkpoint.fragmentEndSu,
                frameLengthSu: checkpoint.frameLengthSu,
                data: checkpoint.data,
                modelSequenceEnd: checkpoint.modelSequenceEnd
              })
            ])
          )
        }
      }
    }
    if (!frameRecord) {
      throw new Error('pty_ownership_transfer_model_checkpoint_unavailable')
    }
    if (
      frameRecord.ptyId !== surfaceBinding.ptyId ||
      frameRecord.frameLengthSu !== frame.data.length ||
      !samePtyOwnershipTransferIdentity(frameRecord.identity, identity) ||
      !samePtyOwnershipTransferSurfaceBinding(frameRecord.surfaceBinding, surfaceBinding)
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
    }
    const fragments = [...frameRecord.fragments.values()].sort(
      (left, right) => left.fragmentStartSu - right.fragmentStartSu
    )
    let nextFragmentSu = 0
    let assembled = ''
    let previousModelSequenceEnd = 0
    for (const fragment of fragments) {
      if (
        fragment.fragmentStartSu !== nextFragmentSu ||
        fragment.fragmentEndSu <= fragment.fragmentStartSu ||
        (assembled.length > 0 && fragment.modelSequenceEnd <= previousModelSequenceEnd)
      ) {
        throw new Error('pty_ownership_transfer_model_checkpoint_gap')
      }
      assembled += fragment.data
      nextFragmentSu = fragment.fragmentEndSu
      previousModelSequenceEnd = fragment.modelSequenceEnd
    }
    if (nextFragmentSu !== frameRecord.frameLengthSu || assembled !== frame.data) {
      throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
    }
    return { identity: Object.freeze({ ...identity }), throughSeq: frame.seq }
  }
}
