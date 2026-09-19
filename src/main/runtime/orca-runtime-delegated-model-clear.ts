import { OrcaRuntimeWithDelegatedModelIngress } from './orca-runtime-delegated-model-ingress'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import { restorePtyOwnershipModelProjection } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-model-projection-recovery'
import { hasDelegatedPtyProviderRoute } from '../ipc/pty/provider/delegated-provider-routes'
import { getProviderForPty } from '../ipc/pty/provider/registry'
import { MAX_PTY_OWNERSHIP_MODEL_CLEAR_OPERATIONS } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-model-clear'

export class OrcaRuntimeWithDelegatedModelClear extends OrcaRuntimeWithDelegatedModelIngress {
  override async clearTerminalBuffer(
    handle: string
  ): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (leaf?.ptyId && hasDelegatedPtyProviderRoute(leaf.ptyId)) {
      await getProviderForPty(leaf.ptyId).clearBuffer(leaf.ptyId)
      return { handle, cleared: true }
    }
    return super.clearTerminalBuffer(handle)
  }

  override async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    if (hasDelegatedPtyProviderRoute(ptyId)) {
      throw new Error('pty_ownership_transfer_model_clear_requires_provider')
    }
    await super.clearHeadlessTerminalBuffer(ptyId)
  }

  async clearPublishedDelegatedPtyModel(
    value: PtyOwnershipTransferWireIdentity,
    operationId: string,
    claimValue: PtyOwnershipTransferDestinationClaim,
    signal?: AbortSignal
  ): Promise<void> {
    const identity = Object.freeze({ ...value })
    const claim = Object.freeze({ ...claimValue })
    if (!operationId || typeof operationId !== 'string' || operationId.length > 256) {
      throw new Error('pty_ownership_transfer_model_clear_operation_invalid')
    }
    const registry = this.ptyOwnershipTransferDestinationRegistry
    const destination = registry?.getPublishedDelegatedDestination(identity)
    if (!destination || !this.store) {
      throw new Error('pty_ownership_transfer_model_clear_unavailable')
    }
    const { adapter, outbox } = destination
    const before = adapter.snapshot()
    const binding = before.surfaceBinding!
    const state = this.delegatedModelState(identity)
    const assertCurrent = () => {
      signal?.throwIfAborted()
      const current = registry!.getPublishedDelegatedDestination(identity).adapter.snapshot()
      if (
        JSON.stringify(current.surfaceBinding) !== JSON.stringify(binding) ||
        JSON.stringify(current.publicationReceipt) !== JSON.stringify(before.publicationReceipt) ||
        !current.delegatedClaimActive ||
        current.delegatedClaim?.claimId !== claim.claimId ||
        current.delegatedClaim.generation !== claim.generation
      ) {
        throw new Error('pty_ownership_transfer_model_clear_authority_changed')
      }
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: (id) => this.ptysById.get(id) ?? null
        },
        identity,
        binding
      )
    }
    assertCurrent()
    if (
      state.busy ||
      state.pending ||
      (state.poisoned && state.pendingClear?.operationId !== operationId)
    ) {
      throw new Error('pty_ownership_transfer_model_clear_unavailable')
    }
    const recorded = outbox.loadModelClear(identity)
    if (!state.pendingClear && recorded?.operationIds.includes(operationId)) {
      if (state.clearRevision !== recorded.operationIds.length) {
        throw new Error('pty_ownership_transfer_model_clear_restore_required')
      }
      return
    }
    if (!state.pendingClear && state.clearRevision !== (recorded?.operationIds.length ?? 0)) {
      throw new Error('pty_ownership_transfer_model_clear_restore_required')
    }
    if (
      !state.pendingClear &&
      (recorded?.operationIds.length ?? 0) >= MAX_PTY_OWNERSHIP_MODEL_CLEAR_OPERATIONS
    ) {
      throw new Error('pty_ownership_transfer_model_clear_capacity')
    }
    const output = outbox.load(identity)!
    const saved = outbox.loadRestorableModel(identity)
    const sequence =
      saved && ('checkpoint' in saved ? saved.checkpoint.modelSequenceEnd : saved.modelSequenceEnd)
    const throughSeq =
      saved && ('checkpoint' in saved ? saved.checkpoint.frameSeq : saved.throughSeq)
    if (
      !saved ||
      sequence !== this.getPtyOutputSequence(binding.ptyId) ||
      throughSeq !== output.acknowledgedEndSeq ||
      (!state.pendingClear && output.pendingFrames.length) ||
      ('checkpoint' in saved && saved.checkpoint.fragmentEndSu !== saved.checkpoint.frameLengthSu)
    ) {
      throw new Error('pty_ownership_transfer_model_clear_boundary_changed')
    }
    state.busy = true
    let finish!: () => void
    state.clearCompletion = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      if (!state.pendingClear) {
        // A failed emulator mutation cannot safely be replayed over later output.
        state.poisoned = true
        await super.clearHeadlessTerminalBuffer(binding.ptyId)
        assertCurrent()
        const model = await this.serializeHeadlessTerminalBuffer(binding.ptyId, {
          scrollbackRows: normalizeDesktopTerminalScrollbackRows(
            this.store.getSettings().terminalScrollbackRows
          ),
          includeEmpty: true
        })
        assertCurrent()
        if (!model || model.seq !== sequence) {
          throw new Error('pty_ownership_transfer_model_clear_boundary_changed')
        }
        state.pendingClear = {
          operationId,
          expectedRevision: state.clearRevision,
          throughSeq: throughSeq!,
          modelSequenceEnd: sequence!,
          model: {
            modelData: `${model.scrollbackAnsi ?? ''}${model.data}${model.frameRestoreAnsi ?? ''}`,
            cols: model.cols,
            rows: model.rows,
            restoreMetadata: {
              version: 1,
              kittyKeyboardFlags: model.kittyKeyboardFlags,
              cwd: model.cwd,
              lastTitle: model.lastTitle,
              oscLinks: model.oscLinks,
              terminalOwner: model.terminalOwner,
              pendingEscapeTailAnsi: model.pendingEscapeTailAnsi
            }
          }
        }
      }
      assertCurrent()
      outbox.recordModelClear(identity, state.pendingClear)
      restorePtyOwnershipModelProjection(adapter.snapshot(), outbox, this.store)
      state.clearRevision = outbox.loadModelClear(identity)!.operationIds.length
      state.pendingClear = undefined
      state.poisoned = false
    } finally {
      state.busy = false
      state.clearCompletion = undefined
      finish()
    }
  }
}
