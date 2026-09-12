import type {
  SshChannelMultiplexer,
  SshMultiplexerRequestOptions
} from '../ssh/ssh-channel-multiplexer'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type { SshPtySourceFrame } from './ssh-pty-source-frame'
import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'

export type PendingSshPtySourceData = Readonly<{
  relayPtyId: string
  params: Record<string, unknown>
  data: string
  source?: SshPtySourceFrame
}>

export type SourceDeliveryLeaseState = {
  phase: 'provisional' | 'recovery' | 'committing' | 'committed' | 'retired'
  pendingData: PendingSshPtySourceData[]
  recoverySink?: (pending: PendingSshPtySourceData) => void
  exited: boolean
}

export type SourceDeliveryState = Readonly<{
  activation: PtySourceReceivingActivation
  sourceEndSu: number
  ownershipTransfer?: PtyOwnershipTransferOutputEnvelope
  ownershipTransferProgress?: Readonly<{
    frameSeq: number
    frameLengthSu: number
    fragmentEndSu: number
  }>
  lease: SourceDeliveryLeaseState
  previous?: SourceDeliveryState
}>

export type SshPtyRecoveryActivationLease = Readonly<{
  commit: () => void
  retire: () => void
}>

export type SshPtySourceDeliveryLease = Readonly<{
  commit: () => void
  rollback: () => Promise<boolean>
  transferToRecovery: (
    sink: (pending: PendingSshPtySourceData) => void
  ) => SshPtyRecoveryActivationLease
}>

export type SshPtyRejectedSourceRecovery =
  | 'confirm-existing'
  | 'fresh-activation'
  | 'reconnect-channel'

export type RejectedSourceIdentity = Readonly<{
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
}>

export function settledReceivingActivationLease(): SshPtySourceDeliveryLease {
  return Object.freeze({
    commit: () => {},
    rollback: async () => true,
    transferToRecovery: () => Object.freeze({ commit: () => {}, retire: () => {} })
  })
}

export function activePredecessor(previous?: SourceDeliveryState): SourceDeliveryState | undefined {
  while (previous?.lease.phase === 'retired') {
    previous = previous.previous
  }
  return previous
}

export function sameReceivingActivation(
  left: PtySourceReceivingActivation,
  right: PtySourceReceivingActivation
): boolean {
  return (
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.deliveryToken === right.deliveryToken &&
    left.checkpointSourceEndSu === right.checkpointSourceEndSu &&
    left.recoveryEndSu === right.recoveryEndSu
  )
}

export function sameRejectedSourceIdentity(
  left: PtySourceReceivingActivation,
  right: RejectedSourceIdentity
): boolean {
  return (
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.deliveryToken === right.deliveryToken
  )
}

export function acceptsSourceFrame(
  current: SourceDeliveryState | undefined,
  params: Record<string, unknown>,
  source: SshPtySourceFrame
): current is SourceDeliveryState {
  return Boolean(
    current &&
    current.lease.phase !== 'retired' &&
    !current.lease.exited &&
    current.activation.ptyIncarnation === params.ptyIncarnation &&
    current.activation.deliveryToken === source.deliveryToken &&
    current.activation.clientGeneration === source.clientGeneration &&
    current.activation.ownerGeneration === source.ownerGeneration &&
    current.sourceEndSu === source.sourceStartSu &&
    (!source.ownershipTransfer ||
      !current.ownershipTransfer ||
      sameOwnershipTransferIdentity(current.ownershipTransfer, source.ownershipTransfer)) &&
    acceptsOwnershipTransferProgress(current.ownershipTransferProgress, source.ownershipTransfer)
  )
}

function acceptsOwnershipTransferProgress(
  progress: SourceDeliveryState['ownershipTransferProgress'],
  envelope: PtyOwnershipTransferOutputEnvelope | undefined
): boolean {
  if (!envelope || !progress) {
    return true
  }
  if (envelope.frameSeq === progress.frameSeq) {
    return (
      envelope.frameLengthSu === progress.frameLengthSu &&
      envelope.fragmentStartSu === progress.fragmentEndSu
    )
  }
  return (
    progress.fragmentEndSu === progress.frameLengthSu &&
    envelope.frameSeq === progress.frameSeq + 1 &&
    envelope.fragmentStartSu === 0
  )
}

function sameOwnershipTransferIdentity(
  left: PtyOwnershipTransferOutputEnvelope,
  right: PtyOwnershipTransferOutputEnvelope
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId &&
    left.version === right.version
  )
}

export async function settleExactSourceDeliveryCancellation(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  activation: RejectedSourceIdentity
): Promise<boolean> {
  try {
    await requestSourceDeliveryCancellation(mux, relayPtyId, activation)
    return true
  } catch {
    return false
  }
}

/** Requires host-delivery evidence; local provider generations are not interchangeable. */
export async function confirmSettledSourceDeliveryCancellation(
  mux: Pick<SshChannelMultiplexer, 'request'>,
  identityValue: unknown,
  expectedDelivery: unknown,
  assertAuthority: () => void,
  options?: SshMultiplexerRequestOptions
) {
  const identity = parsePtyOwnershipTransferWireIdentity(identityValue)
  const { delivery } = parsePtyOwnershipCaptureBoundary(
    {
      version: 1,
      identity,
      throughSeq: 0,
      delivery: expectedDelivery
    },
    identity
  )
  const assertCurrent = () => {
    assertAuthority()
    options?.signal?.throwIfAborted()
  }
  assertCurrent()
  const cancellation = await requestSourceDeliveryCancellation(
    mux,
    identity.terminalId,
    delivery,
    options
  )
  assertCurrent()
  if (
    cancellation.sentEndSu !== delivery.sentEndSu ||
    cancellation.creditedEndSu !== delivery.creditedEndSu
  ) {
    throw new Error('orcad_source_cancellation_boundary_mismatch')
  }
  return Object.freeze({ identity: Object.freeze(identity), delivery, cancellation })
}

async function requestSourceDeliveryCancellation(
  mux: Pick<SshChannelMultiplexer, 'request'>,
  relayPtyId: string,
  activation: RejectedSourceIdentity,
  options?: SshMultiplexerRequestOptions
) {
  const params = {
    id: relayPtyId,
    clientGeneration: activation.clientGeneration,
    ownerGeneration: activation.ownerGeneration,
    deliveryToken: activation.deliveryToken
  }
  const result = (
    options === undefined
      ? await mux.request('pty.cancelDelivery', params)
      : await mux.request('pty.cancelDelivery', params, options)
  ) as Record<string, unknown>
  if (
    !result ||
    result.canceled !== true ||
    !nonNegativeSafeInteger(result.sentEndSu) ||
    !nonNegativeSafeInteger(result.creditedEndSu) ||
    result.creditedEndSu > result.sentEndSu
  ) {
    throw new Error('pty_source_cancellation_response_invalid')
  }
  return Object.freeze({
    canceled: true as const,
    sentEndSu: result.sentEndSu,
    creditedEndSu: result.creditedEndSu
  })
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
