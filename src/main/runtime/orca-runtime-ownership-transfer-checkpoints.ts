import { samePtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import type { PtyOwnershipTransferTerminalModelCheckpointRequest } from '../persistence/loading-store/pty-ownership-transfer-surface-persistence'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import type {
  RuntimePtyOwnershipTransferModelCheckpoint,
  PtyOwnershipTransferModelCheckpointFragment
} from './runtime-ownership-transfer-contracts'
import { samePtyOwnershipTransferIdentity } from './runtime-ownership-transfer-contracts'
import { OrcaRuntimeWithOwnershipTransferRecovery } from './orca-runtime-ownership-transfer-recovery'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'

export class OrcaRuntimeWithOwnershipTransferCheckpoints extends OrcaRuntimeWithOwnershipTransferRecovery {
  async initializeDelegatedPtyOwnershipModel(
    identity: PtyOwnershipTransferWireIdentity,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    const registry = this.ptyOwnershipTransferDestinationRegistry
    const snapshot = registry?.get(identity.bridgeId)?.snapshot()
    const outbox = registry?.getDelegatedModelOutbox(identity)
    const output = outbox?.load(identity)
    if (
      !snapshot?.surfaceBinding ||
      !samePtyOwnershipTransferIdentity(snapshot.identity, identity) ||
      !output ||
      snapshot.phase === 'aborted'
    ) {
      throw new Error('pty_ownership_transfer_model_initialization_unavailable')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (id) => this.ptysById.get(id) ?? null
      },
      identity,
      snapshot.surfaceBinding
    )
    if (outbox!.loadModelSnapshot(identity) || outbox!.loadInitialModelSnapshot(identity)) {
      await this.restoreDelegatedPtyOwnershipModel(identity, signal)
      return
    }
    if (
      output.baseEndSeq !== 0 ||
      output.acknowledgedEndSeq !== 0 ||
      this.getPtyOutputSequence(snapshot.surfaceBinding.ptyId) !== 0
    ) {
      throw new Error('pty_ownership_transfer_model_initial_baseline_unavailable')
    }
  }

  async restoreDelegatedPtyOwnershipModel(
    value: PtyOwnershipTransferWireIdentity,
    signal?: AbortSignal
  ) {
    const identity = Object.freeze({ ...value })
    const destination = this.ptyOwnershipTransferDestinationRegistry
    const adapter = destination?.get(identity.bridgeId)
    const modelOutbox = destination?.getDelegatedModelOutbox(identity)
    const loadModel = () => modelOutbox?.loadRestorableModel(identity)
    const model = loadModel()
    const before = adapter?.snapshot()
    if (
      !model?.restoreMetadata ||
      !before?.surfaceBinding ||
      !before.publicationReceipt ||
      before.phase !== 'published'
    ) {
      throw new Error('pty_ownership_transfer_model_restore_unavailable')
    }
    const isCurrent = () => {
      signal?.throwIfAborted()
      const current = adapter!.snapshot()
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
        },
        identity,
        before.surfaceBinding!
      )
      return (
        current.phase === 'published' &&
        samePtyOwnershipTransferIdentity(current.identity, identity) &&
        !!current.surfaceBinding &&
        samePtyOwnershipTransferSurfaceBinding(current.surfaceBinding, before.surfaceBinding!) &&
        !!current.publicationReceipt &&
        samePtyOwnershipTransferPublicationReceipt(
          current.publicationReceipt,
          before.publicationReceipt!
        ) &&
        JSON.stringify(loadModel()) === JSON.stringify(model)
      )
    }
    await this.restoreHeadlessTerminalModel(
      before.surfaceBinding.ptyId,
      {
        modelData: model.modelData,
        allowEmpty: model.modelData === '',
        cols: model.cols,
        rows: model.rows,
        sequence:
          'checkpoint' in model ? model.checkpoint.modelSequenceEnd : model.modelSequenceEnd,
        restoreMetadata: model.restoreMetadata
      },
      isCurrent
    )
    return 'checkpoint' in model ? Object.freeze({ ...model.checkpoint }) : null
  }

  async checkpointPtyOwnershipTransferModel(
    request: RuntimePtyOwnershipTransferModelCheckpoint
  ): Promise<void> {
    const destination = this.ptyOwnershipTransferDestinationRegistry
    const persist = this.store?.checkpointPtyOwnershipTransferTerminalModel
    if (!destination || !persist) {
      throw new Error('pty_ownership_transfer_model_checkpoint_unavailable')
    }
    const transfer = request.ownershipTransfer
    if (
      request.ptyIncarnation !== transfer.incarnationId ||
      transfer.destinationRuntimeId !== this.runtimeId ||
      !Number.isSafeInteger(request.modelSequenceEnd) ||
      request.modelSequenceEnd <= 0 ||
      request.projectionSequenceEnd !== request.modelSequenceEnd
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_invalid')
    }
    const adapter = destination.get(transfer.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_model_checkpoint_destination_unavailable')
    }
    const before = adapter.snapshot()
    if (
      !before ||
      before.phase !== 'published' ||
      !before.surfaceBinding ||
      !before.publicationReceipt ||
      !samePtyOwnershipTransferIdentity(before.identity, transfer)
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_destination_unavailable')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
      },
      before.identity,
      before.surfaceBinding
    )
    if (before.surfaceBinding.ptyId !== request.ptyId) {
      throw new Error('pty_ownership_transfer_model_checkpoint_route_mismatch')
    }

    const snapshot = await this.serializeHeadlessTerminalBuffer(request.ptyId, {
      scrollbackRows: normalizeDesktopTerminalScrollbackRows(
        this.store?.getSettings().terminalScrollbackRows
      ),
      includeEmpty: true
    })
    if (!snapshot || snapshot.seq !== request.modelSequenceEnd) {
      throw new Error('pty_ownership_transfer_model_checkpoint_sequence_mismatch')
    }
    const after = adapter.snapshot()
    if (
      after.phase !== 'published' ||
      !after.surfaceBinding ||
      !after.publicationReceipt ||
      !samePtyOwnershipTransferIdentity(after.identity, before.identity) ||
      !samePtyOwnershipTransferPublicationReceipt(
        after.publicationReceipt,
        before.publicationReceipt
      ) ||
      this.getPtyOutputSequence(request.ptyId) !== request.modelSequenceEnd
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_superseded')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
      },
      after.identity,
      after.surfaceBinding
    )
    const modelData = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}${snapshot.frameRestoreAnsi ?? ''}`
    const checkpoint: PtyOwnershipTransferTerminalModelCheckpointRequest = {
      identity: after.identity,
      surfaceBinding: after.surfaceBinding,
      publicationReceipt: after.publicationReceipt,
      modelData: `${modelData}${snapshot.pendingEscapeTailAnsi ?? ''}`
    }
    const fragment = {
      ptyId: request.ptyId,
      frameSeq: transfer.frameSeq,
      fragmentStartSu: transfer.fragmentStartSu,
      fragmentEndSu: transfer.fragmentEndSu,
      frameLengthSu: transfer.frameLengthSu,
      data: request.data,
      modelSequenceEnd: request.modelSequenceEnd
    }
    const modelOutbox = destination.getDelegatedModelOutbox(after.identity)
    if (modelOutbox) {
      modelOutbox.recordModelSnapshot(after.identity, {
        checkpoint: fragment,
        modelData,
        cols: snapshot.cols,
        rows: snapshot.rows,
        restoreMetadata: {
          version: 1,
          kittyKeyboardFlags: snapshot.kittyKeyboardFlags,
          cwd: snapshot.cwd,
          lastTitle: snapshot.lastTitle,
          oscLinks: snapshot.oscLinks,
          terminalOwner: snapshot.terminalOwner,
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
        }
      })
    }
    persist.call(this.store, checkpoint)
    if (!modelOutbox) {
      destination.recordModelCheckpoint(after.identity, fragment)
    }
    this.recordPtyOwnershipTransferModelCheckpoint({
      identity: after.identity,
      surfaceBinding: after.surfaceBinding,
      ptyId: request.ptyId,
      frameSeq: transfer.frameSeq,
      fragmentStartSu: transfer.fragmentStartSu,
      fragmentEndSu: transfer.fragmentEndSu,
      frameLengthSu: transfer.frameLengthSu,
      data: request.data,
      modelSequenceEnd: request.modelSequenceEnd
    })
  }

  protected recordPtyOwnershipTransferModelCheckpoint(
    fragment: PtyOwnershipTransferModelCheckpointFragment
  ): void {
    let frames = this.ptyOwnershipTransferModelCheckpointsByBridge.get(fragment.identity.bridgeId)
    if (!frames) {
      frames = new Map()
      this.ptyOwnershipTransferModelCheckpointsByBridge.set(fragment.identity.bridgeId, frames)
    }
    const existing = frames.get(fragment.frameSeq)
    if (existing) {
      if (
        !samePtyOwnershipTransferIdentity(existing.identity, fragment.identity) ||
        existing.ptyId !== fragment.ptyId ||
        existing.frameLengthSu !== fragment.frameLengthSu ||
        !samePtyOwnershipTransferSurfaceBinding(existing.surfaceBinding, fragment.surfaceBinding)
      ) {
        throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
      }
    } else {
      frames.set(fragment.frameSeq, {
        identity: Object.freeze({ ...fragment.identity }),
        surfaceBinding: Object.freeze({ ...fragment.surfaceBinding }),
        ptyId: fragment.ptyId,
        frameLengthSu: fragment.frameLengthSu,
        fragments: new Map()
      })
    }
    const frame = frames.get(fragment.frameSeq)!
    const previous = frame.fragments.get(fragment.fragmentStartSu)
    if (previous) {
      if (
        previous.fragmentEndSu !== fragment.fragmentEndSu ||
        previous.data !== fragment.data ||
        previous.modelSequenceEnd !== fragment.modelSequenceEnd
      ) {
        throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
      }
      return
    }
    frame.fragments.set(fragment.fragmentStartSu, Object.freeze({ ...fragment }))
    // Keep this receipt ledger bounded across long-lived SSH sessions.
    const allFrames = [...this.ptyOwnershipTransferModelCheckpointsByBridge.values()]
    let count = allFrames.reduce((total, entries) => total + entries.size, 0)
    while (count > 4096) {
      const first = allFrames.find((entries) => entries.size > 0)
      const oldest = first ? [...first.keys()].sort((left, right) => left - right)[0] : undefined
      if (first && oldest !== undefined) {
        first.delete(oldest)
        count -= 1
      } else {
        break
      }
    }
  }
}
