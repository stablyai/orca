import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type { SshPtySourceFrame } from './ssh-pty-source-frame'

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
    current.sourceEndSu === source.sourceStartSu
  )
}

export async function settleExactSourceDeliveryCancellation(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  activation: RejectedSourceIdentity
): Promise<boolean> {
  try {
    const result = (await mux.request('pty.cancelDelivery', {
      id: relayPtyId,
      clientGeneration: activation.clientGeneration,
      ownerGeneration: activation.ownerGeneration,
      deliveryToken: activation.deliveryToken
    })) as Record<string, unknown>
    return (
      result.canceled === true &&
      nonNegativeSafeInteger(result.sentEndSu) &&
      nonNegativeSafeInteger(result.creditedEndSu) &&
      result.creditedEndSu <= result.sentEndSu
    )
  } catch {
    return false
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
