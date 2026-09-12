import { OrcaRuntimeWithOutgoingSshCatalog } from './orca-runtime-outgoing-ssh-catalog'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import {
  parsePtyOwnershipCaptureBoundary,
  type PtyOwnershipCaptureBoundary
} from '../../shared/pty-ownership-capture-boundary'
import { requireSshPtyCaptureModelCheckpoint } from '../ssh/ssh-pty-capture-model-checkpoint'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'

export class OrcaRuntimeWithDelegatedModelIngress extends OrcaRuntimeWithOutgoingSshCatalog {
  async serializeSshPtyOwnershipCapture(
    value: PtyOwnershipCaptureBoundary,
    routeValue: Readonly<{ ptyId: string; providerGeneration: number }>,
    signal?: AbortSignal
  ) {
    const boundary = parsePtyOwnershipCaptureBoundary(value, value.identity)
    const route = Object.freeze({ ...routeValue })
    const parsed = parseAppSshPtyId(route.ptyId)
    const tracked = this.ptysById.get(route.ptyId)
    const sequence = this.getPtyOutputSequence(route.ptyId)
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (
        !parsed ||
        parsed.relayPtyId !== boundary.identity.terminalId ||
        !tracked ||
        this.ptysById.get(route.ptyId) !== tracked ||
        tracked.connectionId !== parsed.connectionId ||
        tracked.incarnationId !== boundary.identity.incarnationId ||
        this.getPtyOutputSequence(route.ptyId) !== sequence
      ) {
        throw new Error('pty_ownership_capture_model_route_changed')
      }
      requireSshPtyCaptureModelCheckpoint(boundary, route)
    }
    assertCurrent()
    const model = await this.serializeHeadlessTerminalBuffer(route.ptyId, {
      scrollbackRows: normalizeDesktopTerminalScrollbackRows(
        this.store?.getSettings().terminalScrollbackRows
      ),
      includeEmpty: true
    })
    assertCurrent()
    if (!model || model.seq !== sequence) {
      throw new Error('pty_ownership_capture_model_sequence_changed')
    }
    return parsePtyOwnershipInitialModelSnapshot(
      {
        version: 1,
        identity: boundary.identity,
        throughSeq: boundary.throughSeq,
        modelSequenceEnd: sequence,
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
      },
      boundary.identity,
      boundary.throughSeq
    )
  }

  async prepareDelegatedPtyModelFrame(
    value: PtyOwnershipTransferWireIdentity,
    frameValue: PtyOwnershipTransferOutputFrame,
    signal?: AbortSignal
  ): Promise<void> {
    const identity = Object.freeze({ ...value })
    const frame = Object.freeze({ ...frameValue })
    const state = this.delegatedModelState(identity)
    if (state.clearCompletion) {
      await state.clearCompletion
      signal?.throwIfAborted()
    }
    if (
      state.busy ||
      state.poisoned ||
      !samePtyOwnershipTransferIdentity(state.identity, identity)
    ) {
      throw new Error('pty_ownership_transfer_model_ingress_unavailable')
    }
    const registry = this.ptyOwnershipTransferDestinationRegistry
    const adapter = registry?.get(identity.bridgeId)
    const outbox = registry?.getDelegatedModelOutbox(identity)
    const before = adapter?.snapshot()
    if (
      !outbox ||
      !before?.surfaceBinding ||
      !before.publicationReceipt ||
      before.phase !== 'published'
    ) {
      throw new Error('pty_ownership_transfer_model_ingress_unpublished')
    }
    const binding = before.surfaceBinding
    const assertCurrent = () => {
      signal?.throwIfAborted()
      const current = adapter!.snapshot()
      if (
        !samePtyOwnershipTransferIdentity(current.identity, identity) ||
        current.phase !== 'published' ||
        JSON.stringify(current.surfaceBinding) !== JSON.stringify(binding) ||
        JSON.stringify(current.publicationReceipt) !== JSON.stringify(before.publicationReceipt) ||
        current.delegatedClaim?.generation !== before.delegatedClaim?.generation ||
        current.delegatedClaim?.claimId !== before.delegatedClaim?.claimId ||
        current.delegatedClaimActive !== before.delegatedClaimActive
      ) {
        throw new Error('pty_ownership_transfer_model_ingress_superseded')
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
    const queued = outbox.load(identity)?.pendingFrames.find((entry) => entry.seq === frame.seq)
    if (!queued || queued.data !== frame.data || !frame.data.length) {
      throw new Error('pty_ownership_transfer_model_ingress_frame_mismatch')
    }
    state.busy = true
    try {
      if (!state.pending) {
        const saved = outbox.loadModelSnapshot(identity)
        const initial = saved ? null : outbox.loadInitialModelSnapshot(identity)
        const sequence = this.getPtyOutputSequence(binding.ptyId)
        if (
          sequence !== (saved?.checkpoint.modelSequenceEnd ?? initial?.modelSequenceEnd ?? 0) ||
          (saved && !saved.restoreMetadata) ||
          (!saved && outbox.load(identity)!.acknowledgedEndSeq !== (initial?.throughSeq ?? 0))
        ) {
          throw new Error('pty_ownership_transfer_model_ingress_restore_required')
        }
        let start = 0
        if (saved?.checkpoint.frameSeq === frame.seq) {
          const checkpoint = saved.checkpoint
          if (
            checkpoint.ptyId !== binding.ptyId ||
            checkpoint.frameLengthSu !== frame.data.length ||
            frame.data.slice(checkpoint.fragmentStartSu, checkpoint.fragmentEndSu) !==
              checkpoint.data
          ) {
            throw new Error('pty_ownership_transfer_model_ingress_frame_mismatch')
          }
          start = checkpoint.fragmentEndSu
          if (start === frame.data.length) {
            return
          }
        } else if (
          frame.seq !==
            (saved?.checkpoint.frameSeq ?? outbox.load(identity)!.acknowledgedEndSeq) + 1 ||
          (saved && saved.checkpoint.fragmentEndSu !== saved.checkpoint.frameLengthSu)
        ) {
          throw new Error('pty_ownership_transfer_model_ingress_gap')
        }
        const data = frame.data.slice(start)
        // Admission can mutate the model before throwing; never replay an ambiguous write.
        state.poisoned = true
        const admission = this.acceptPtyDataBounded(binding.ptyId, data, Date.now())
        await admission.completion
        state.pending = {
          ptyId: binding.ptyId,
          ptyIncarnation: identity.incarnationId,
          data,
          modelSequenceEnd: admission.sequence,
          projectionSequenceEnd: admission.sequence,
          ownershipTransfer: {
            ...identity,
            version: 1,
            frameSeq: frame.seq,
            fragmentStartSu: start,
            fragmentEndSu: frame.data.length,
            frameLengthSu: frame.data.length
          }
        }
        state.poisoned = false
      }
      const pending = state.pending
      if (
        pending.ownershipTransfer.frameSeq !== frame.seq ||
        pending.ptyId !== binding.ptyId ||
        pending.ownershipTransfer.frameLengthSu !== frame.data.length ||
        frame.data.slice(pending.ownershipTransfer.fragmentStartSu) !== pending.data ||
        this.getPtyOutputSequence(binding.ptyId) !== pending.modelSequenceEnd
      ) {
        throw new Error('pty_ownership_transfer_model_ingress_pending_conflict')
      }
      assertCurrent()
      await this.checkpointPtyOwnershipTransferModel(pending)
      assertCurrent()
      state.pending = undefined
    } finally {
      state.busy = false
    }
  }
}
