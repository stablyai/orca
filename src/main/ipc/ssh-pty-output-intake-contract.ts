import type { LegacySshProjectionSemantics } from './ssh-pty-legacy-projection'
import type {
  SshPtyModelAdmissionOptions,
  SshPtyModelAdmissionReceipt
} from './ssh-pty-model-admission-contract'
import type { PtySourceCreditAckBatch } from '../../shared/pty-source-credit-contract'

export type SshPtySourceCancellationRequest = Readonly<{
  id: string
  clientGeneration: number
  ownerGeneration: number
  deliveryToken: string
}>

export type SshPtySourceCancellationProof = Readonly<{
  sentEndSu: number
  creditedEndSu: number
}>

export type SshPtyOutputDataEvent = Readonly<{
  id: string
  data: string
  providerGeneration: number
  ptyIncarnation: string
  rawLength: number
  transformed: boolean
  sequence?: number
  source?: Readonly<{
    relayPtyId?: string
    spanId: string
    clientGeneration: number
    ownerGeneration: number
    deliveryToken: string
    sourceStartSu: number
    sourceEndSu: number
  }>
}>

export type SshPtyOutputExitEvent = Readonly<{
  id: string
  code: number
  providerGeneration: number
  ptyIncarnation: string
}>

export type SshPtyOutputReceipt = SshPtyModelAdmissionReceipt &
  Readonly<{ projection: LegacySshProjectionSemantics }>

export type SshPtyOutputIntakeDependencies = {
  getModelSequence: (id: string) => number
  acceptModel: (
    event: SshPtyOutputDataEvent,
    projection: LegacySshProjectionSemantics
  ) => { sequence: number; completion: Promise<void> }
  project: (event: SshPtyOutputDataEvent, projection: LegacySshProjectionSemantics) => void
  prepareExit: (event: SshPtyOutputExitEvent) => void | (() => void)
  finalizeExit: (event: SshPtyOutputExitEvent) => void
  pauseProvider?: (providerGeneration: number, id: string) => boolean
  resumeProvider?: (providerGeneration: number, id: string) => void
  closeProvider?: (providerGeneration: number, reason: string) => void
  resetModelForMigration?: (providerGeneration: number, id: string) => void
  onGenerationClosed?: (providerGeneration: number, reason: string) => void
  publishSourceAck?: (
    providerGeneration: number,
    batch: PtySourceCreditAckBatch,
    onSettled: (result: { ok: true } | { ok: false; error: Error }) => void
  ) => void
  cancelSourceDelivery?: (
    providerGeneration: number,
    request: SshPtySourceCancellationRequest
  ) => Promise<SshPtySourceCancellationProof>
}

export type SshPtyOutputIntakeOptions = SshPtyModelAdmissionOptions & {
  exitBarrierMs?: number
  exitCancellationProofMs?: number
}
