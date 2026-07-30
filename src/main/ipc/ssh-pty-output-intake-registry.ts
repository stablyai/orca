import type { SshPtyOutputIntake } from './ssh-pty-output-intake'
import type {
  SshPtyOutputDataEvent,
  SshPtyOutputExitEvent,
  SshPtyOutputReceipt,
  SshPtySourceCancellationProof,
  SshPtySourceCancellationRequest
} from './ssh-pty-output-intake-contract'
import type { SshPtyAcceptedSourceCheckpoint } from './ssh-pty-output-source-obligations'
import type { PtySourceCreditAckBatch } from '../../shared/pty-source-credit-contract'
import type { SshPtyOutputGenerationMigration } from './ssh-pty-output-model-migration'

let installedIntake: SshPtyOutputIntake | null = null
let nextProviderGeneration = 1
const sourceAckPublishers = new Map<number, SshPtySourceAckPublisher>()
const sourceCancellationPublishers = new Map<number, SshPtySourceCancellationPublisher>()

type SshPtySourceAckPublisher = (
  batch: PtySourceCreditAckBatch,
  onSettled: (result: { ok: true } | { ok: false; error: Error }) => void
) => void

type SshPtySourceCancellationPublisher = (
  request: SshPtySourceCancellationRequest
) => Promise<SshPtySourceCancellationProof>

export function allocateSshPtyProviderGeneration(): number {
  return nextProviderGeneration++
}

export function installSshPtyOutputIntake(intake: SshPtyOutputIntake): () => void {
  const previous = installedIntake
  installedIntake = intake
  previous?.dispose()
  return () => {
    if (installedIntake === intake) {
      installedIntake = null
      intake.dispose()
    }
  }
}

export function acceptSshPtyOutputData(event: SshPtyOutputDataEvent): Promise<SshPtyOutputReceipt> {
  return installedIntake
    ? installedIntake.acceptData(event)
    : Promise.reject(outputIntakeUnavailableError())
}

export function acceptSshPtyOutputExit(event: SshPtyOutputExitEvent): Promise<void> {
  return installedIntake
    ? installedIntake.acceptExit(event)
    : Promise.reject(outputIntakeUnavailableError())
}

export function closeSshPtyOutputGeneration(providerGeneration: number, reason: string): void {
  installedIntake?.closeGeneration(providerGeneration, reason)
}

export function getSshPtyAcceptedSourceCheckpoints(
  providerGeneration: number
): readonly SshPtyAcceptedSourceCheckpoint[] {
  return installedIntake?.getAcceptedSourceCheckpoints(providerGeneration) ?? []
}

export function beginSshPtyOutputGenerationMigration(
  providerGeneration: number
): SshPtyOutputGenerationMigration {
  return (
    installedIntake?.beginGenerationMigration(providerGeneration) ?? {
      byPty: new Map(),
      completion: Promise.resolve()
    }
  )
}

export function installSshPtySourceAckPublisher(
  providerGeneration: number,
  publish: SshPtySourceAckPublisher
): () => void {
  if (sourceAckPublishers.has(providerGeneration)) {
    throw new Error('ssh_source_ack_publisher_duplicate_generation')
  }
  sourceAckPublishers.set(providerGeneration, publish)
  return () => {
    if (sourceAckPublishers.get(providerGeneration) === publish) {
      sourceAckPublishers.delete(providerGeneration)
    }
  }
}

export function publishSshPtySourceAck(
  providerGeneration: number,
  batch: PtySourceCreditAckBatch,
  onSettled: (result: { ok: true } | { ok: false; error: Error }) => void
): void {
  const publisher = sourceAckPublishers.get(providerGeneration)
  if (!publisher) {
    onSettled({ ok: false, error: new Error('ssh_source_ack_publisher_unavailable') })
    return
  }
  publisher(batch, onSettled)
}

export function installSshPtySourceCancellationPublisher(
  providerGeneration: number,
  cancel: SshPtySourceCancellationPublisher
): () => void {
  if (sourceCancellationPublishers.has(providerGeneration)) {
    throw new Error('ssh_source_cancellation_publisher_duplicate_generation')
  }
  sourceCancellationPublishers.set(providerGeneration, cancel)
  return () => {
    if (sourceCancellationPublishers.get(providerGeneration) === cancel) {
      sourceCancellationPublishers.delete(providerGeneration)
    }
  }
}

export function cancelSshPtySourceDelivery(
  providerGeneration: number,
  request: SshPtySourceCancellationRequest
): Promise<SshPtySourceCancellationProof> {
  const publisher = sourceCancellationPublishers.get(providerGeneration)
  return publisher
    ? publisher(request)
    : Promise.reject(new Error('ssh_source_cancellation_publisher_unavailable'))
}

export function applySshPtySourceCancellationProof(
  event: SshPtyOutputExitEvent,
  proof: SshPtySourceCancellationProof
): boolean {
  return installedIntake?.applySourceCancellationProof(event, proof) ?? false
}

export function applySshPtySourceRecoveryCancellationProof(
  event: SshPtyOutputExitEvent,
  proof: SshPtySourceCancellationProof
): boolean {
  if (!installedIntake) {
    return false
  }
  installedIntake.applySourceRecoveryCancellationProof(event, proof)
  return true
}

function outputIntakeUnavailableError(): Error {
  return Object.assign(new Error('ssh_output_intake_unavailable'), {
    code: 'ssh_output_intake_unavailable'
  })
}
