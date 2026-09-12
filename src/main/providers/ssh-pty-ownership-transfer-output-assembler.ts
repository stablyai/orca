import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../../shared/pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES } from '../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { SshPtyDataCallback } from './ssh-pty-provider-contract'

type SshPtyDataPayload = Parameters<SshPtyDataCallback>[0]

export type SshPtyOwnershipTransferSourceRange = Readonly<{
  providerGeneration: number
  relayPtyId: string
  spanId: string
  clientGeneration: number
  ownerGeneration: number
  deliveryToken: string
  ptyIncarnation: string
  sourceStartSu: number
  sourceEndSu: number
  ownershipTransfer: NonNullable<NonNullable<SshPtyDataPayload['source']>['ownershipTransfer']>
}>

type AssemblyFence = Readonly<{
  providerGeneration: number
  ptyIncarnation: string
  clientGeneration: number
  ownerGeneration: number
  deliveryToken: string
}>

type ActiveAssembly = {
  identity: PtyOwnershipTransferWireIdentity
  fence: AssemblyFence
  frameSeq: number
  frameLengthSu: number
  nextFragmentSu: number
  data: string
  bytes: number
  sourceRanges: SshPtyOwnershipTransferSourceRange[]
}

type AssembledFrame = PtyOwnershipTransferOutputFrame &
  Readonly<{ sourceRanges: readonly SshPtyOwnershipTransferSourceRange[] }>

/** Bounded fragment reconstruction after source-credit admission and before destination routing. */
export class SshPtyOwnershipTransferOutputAssembler {
  private readonly activeByBridge = new Map<string, ActiveAssembly>()
  private readonly generationByBridge = new Map<string, number>()
  private readonly fenceByBridge = new Map<string, AssemblyFence>()

  accept(payload: SshPtyDataPayload): PtyOwnershipTransferOutputFrame | null {
    const assembled = this.acceptInternal(payload)
    if (!assembled) {
      return null
    }
    return Object.freeze({ seq: assembled.seq, data: assembled.data })
  }

  private acceptInternal(payload: SshPtyDataPayload): AssembledFrame | null {
    const source = payload.source
    const envelope = source?.ownershipTransfer
    if (!source || !envelope) {
      return null
    }
    const bridgeId = envelope.bridgeId
    const fence = fenceFrom(payload, source)
    const latestGeneration = this.generationByBridge.get(bridgeId)
    if (latestGeneration !== undefined && payload.providerGeneration < latestGeneration) {
      throw new Error('pty_ownership_transfer_output_stale_generation')
    }
    if (latestGeneration === undefined) {
      this.requireCapacity()
      this.generationByBridge.set(bridgeId, payload.providerGeneration)
    } else if (payload.providerGeneration > latestGeneration) {
      this.activeByBridge.delete(bridgeId)
      this.generationByBridge.set(bridgeId, payload.providerGeneration)
      this.fenceByBridge.delete(bridgeId)
    }
    const previousFence = this.fenceByBridge.get(bridgeId)
    if (previousFence && payload.providerGeneration === previousFence.providerGeneration) {
      if (payload.ptyIncarnation !== previousFence.ptyIncarnation) {
        throw new Error('pty_ownership_transfer_output_stale_generation')
      }
      if (fence.clientGeneration < previousFence.clientGeneration) {
        throw new Error('pty_ownership_transfer_output_stale_generation')
      }
      if (fence.clientGeneration === previousFence.clientGeneration) {
        if (!sameFence(previousFence, fence)) {
          throw new Error(
            this.activeByBridge.has(bridgeId)
              ? 'pty_ownership_transfer_output_fragment_conflict'
              : 'pty_ownership_transfer_output_stale_generation'
          )
        }
      } else if (
        fence.ownerGeneration <= previousFence.ownerGeneration ||
        fence.deliveryToken === previousFence.deliveryToken
      ) {
        throw new Error('pty_ownership_transfer_output_stale_generation')
      } else {
        // A newer source activation supersedes any incomplete frame from its predecessor.
        this.activeByBridge.delete(bridgeId)
      }
    }
    this.fenceByBridge.set(bridgeId, fence)
    let active = this.activeByBridge.get(bridgeId)
    if (!active) {
      if (envelope.fragmentStartSu !== 0) {
        throw new Error('pty_ownership_transfer_output_fragment_start_invalid')
      }
      active = {
        identity: identityFrom(envelope),
        fence,
        frameSeq: envelope.frameSeq,
        frameLengthSu: envelope.frameLengthSu,
        nextFragmentSu: 0,
        data: '',
        bytes: 0,
        sourceRanges: []
      }
      this.activeByBridge.set(bridgeId, active)
    }
    if (
      !sameFence(active.fence, fence) ||
      !sameIdentity(active.identity, envelope) ||
      active.frameSeq !== envelope.frameSeq ||
      active.frameLengthSu !== envelope.frameLengthSu ||
      active.nextFragmentSu !== envelope.fragmentStartSu
    ) {
      throw new Error('pty_ownership_transfer_output_fragment_conflict')
    }
    const bytes = Buffer.byteLength(payload.data, 'utf8')
    if (
      active.bytes + bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES ||
      envelope.frameLengthSu > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES
    ) {
      throw new Error('pty_ownership_transfer_output_frame_too_large')
    }
    active.data += payload.data
    active.bytes += bytes
    active.sourceRanges.push(sourceRangeFrom(payload))
    active.nextFragmentSu = envelope.fragmentEndSu
    if (active.nextFragmentSu !== active.frameLengthSu) {
      return null
    }
    this.activeByBridge.delete(bridgeId)
    return Object.freeze({
      seq: active.frameSeq,
      data: active.data,
      sourceRanges: Object.freeze(active.sourceRanges.slice())
    })
  }

  acceptAndDeliver(
    payload: SshPtyDataPayload,
    deliver: (
      identity: PtyOwnershipTransferWireIdentity,
      frame: PtyOwnershipTransferOutputFrame,
      sourceRanges: readonly SshPtyOwnershipTransferSourceRange[]
    ) => void | Promise<void>
  ): void | Promise<void> {
    const envelope = payload.source?.ownershipTransfer
    if (!envelope) {
      return
    }
    const frame = this.acceptInternal(payload)
    if (frame) {
      return deliver(
        identityFrom(envelope),
        Object.freeze({ seq: frame.seq, data: frame.data }),
        frame.sourceRanges
      )
    }
  }

  clear(): void {
    this.activeByBridge.clear()
    this.generationByBridge.clear()
    this.fenceByBridge.clear()
  }

  retire(identity: PtyOwnershipTransferWireIdentity): void {
    const active = this.activeByBridge.get(identity.bridgeId)
    if (active && !sameIdentity(active.identity, identity)) {
      throw new Error('pty_ownership_transfer_output_identity_conflict')
    }
    this.activeByBridge.delete(identity.bridgeId)
    this.generationByBridge.delete(identity.bridgeId)
    this.fenceByBridge.delete(identity.bridgeId)
  }

  private requireCapacity(): void {
    if (this.generationByBridge.size >= MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
      throw new Error('pty_ownership_transfer_output_assembler_capacity')
    }
  }
}

function fenceFrom(
  payload: SshPtyDataPayload,
  source: NonNullable<SshPtyDataPayload['source']>
): AssemblyFence {
  return Object.freeze({
    providerGeneration: payload.providerGeneration,
    ptyIncarnation: payload.ptyIncarnation,
    clientGeneration: source.clientGeneration,
    ownerGeneration: source.ownerGeneration,
    deliveryToken: source.deliveryToken
  })
}

function identityFrom(value: PtyOwnershipTransferWireIdentity): PtyOwnershipTransferWireIdentity {
  return Object.freeze({
    bridgeId: value.bridgeId,
    terminalId: value.terminalId,
    incarnationId: value.incarnationId,
    ownerLease: value.ownerLease,
    sourceOwnerGeneration: value.sourceOwnerGeneration,
    destinationRuntimeId: value.destinationRuntimeId
  })
}

function sourceRangeFrom(payload: SshPtyDataPayload): SshPtyOwnershipTransferSourceRange {
  const source = payload.source
  const ownershipTransfer = source?.ownershipTransfer
  if (!source || !ownershipTransfer) {
    throw new Error('pty_ownership_transfer_output_source_invalid')
  }
  return Object.freeze({
    providerGeneration: payload.providerGeneration,
    relayPtyId: source.relayPtyId,
    spanId: source.spanId,
    clientGeneration: source.clientGeneration,
    ownerGeneration: source.ownerGeneration,
    deliveryToken: source.deliveryToken,
    ptyIncarnation: payload.ptyIncarnation,
    sourceStartSu: source.sourceStartSu,
    sourceEndSu: source.sourceEndSu,
    ownershipTransfer
  })
}

function sameFence(left: AssemblyFence, right: AssemblyFence): boolean {
  return (
    left.providerGeneration === right.providerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.deliveryToken === right.deliveryToken
  )
}

function sameIdentity(
  left: PtyOwnershipTransferWireIdentity,
  right: PtyOwnershipTransferWireIdentity
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId
  )
}
