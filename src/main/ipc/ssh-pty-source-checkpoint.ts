import {
  samePtySourceDelivery,
  type PtySourceDeliveryIdentity
} from '../../shared/pty-source-credit-contract'

export type SshPtyAcceptedSourceCheckpoint = Readonly<{
  id: string
  providerGeneration: number
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  acceptedSourceEndSu: number
}>

type SourceBinding = Readonly<{ appPtyId: string; identity: PtySourceDeliveryIdentity }>

export function sourceAcceptedCheckpoint(
  record: SourceBinding,
  acceptedSourceEndSu: number
): SshPtyAcceptedSourceCheckpoint {
  const { providerGeneration, clientGeneration, ownerGeneration, ptyIncarnation, deliveryToken } =
    record.identity
  return Object.freeze({
    id: record.appPtyId,
    providerGeneration,
    clientGeneration,
    ownerGeneration,
    ptyIncarnation,
    deliveryToken,
    acceptedSourceEndSu
  })
}

export function requireSourceCheckpointIdentity(
  record: SourceBinding | undefined,
  checkpoint: SshPtyAcceptedSourceCheckpoint
) {
  if (
    !record ||
    record.appPtyId !== checkpoint.id ||
    !samePtySourceDelivery(record.identity, { ...checkpoint, id: record.identity.id })
  ) {
    throw new Error('ssh_live_output_settlement_identity_changed')
  }
  return record.identity
}
