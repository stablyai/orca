import { OrcaRuntimeWithDelegatedModelState } from './orca-runtime-delegated-model-state'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'

export class OrcaRuntimeWithDelegatedProviderModel extends OrcaRuntimeWithDelegatedModelState {
  async serializePublishedDelegatedPtyModel(
    identity: PtyOwnershipTransferWireIdentity,
    options: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    const registry = this.ptyOwnershipTransferDestinationRegistry
    if (!registry) {
      throw new Error('pty_ownership_transfer_delegated_registration_unavailable')
    }
    const destination = registry.getPublishedDelegatedDestination(identity)
    const snapshot = destination.adapter.snapshot()
    const binding = snapshot.surfaceBinding!
    const readBoundary = () => {
      const state = this.delegatedModelState(identity)
      const clearRevision = destination.outbox.loadModelClear(identity)?.operationIds.length ?? 0
      if (state.busy || state.poisoned || state.pending || state.clearRevision !== clearRevision) {
        return null
      }
      const current = registry.getPublishedDelegatedDestination(identity)
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: (id) => this.ptysById.get(id) ?? null
        },
        identity,
        binding
      )
      if (
        JSON.stringify(current.adapter.snapshot().surfaceBinding) !== JSON.stringify(binding) ||
        JSON.stringify(current.adapter.snapshot().publicationReceipt) !==
          JSON.stringify(snapshot.publicationReceipt)
      ) {
        throw new Error('pty_ownership_transfer_delegated_snapshot_superseded')
      }
      const output = destination.outbox.load(identity)
      const model = destination.outbox.loadModelSnapshot(identity)
      const initial = model ? null : destination.outbox.loadInitialModelSnapshot(identity)
      const throughSeq = model?.checkpoint.frameSeq ?? initial?.throughSeq ?? 0
      const modelSequence = model?.checkpoint.modelSequenceEnd ?? initial?.modelSequenceEnd ?? 0
      if (
        !output ||
        output.pendingFrames.length ||
        output.acceptedEndSeq !== output.acknowledgedEndSeq ||
        output.acknowledgedEndSeq !== throughSeq ||
        (model && model.checkpoint.fragmentEndSu !== model.checkpoint.frameLengthSu) ||
        this.getPtyOutputSequence(binding.ptyId) !== modelSequence
      ) {
        return null
      }
      return {
        throughSeq,
        modelSequence,
        clearRevision
      }
    }
    const before = readBoundary()
    if (!before) {
      return null
    }
    const model = await this.serializeMainTerminalBuffer(binding.ptyId, { ...options })
    const after = readBoundary()
    if (
      !after ||
      after.throughSeq !== before.throughSeq ||
      after.modelSequence !== before.modelSequence ||
      after.clearRevision !== before.clearRevision ||
      !model ||
      model.source !== 'headless' ||
      model.seq !== before.modelSequence
    ) {
      return null
    }
    return { ...model, seq: before.modelSequence, source: 'headless' }
  }
}
