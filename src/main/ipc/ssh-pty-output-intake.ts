import {
  SshPtyLegacyProjectionLedger,
  type LegacySshProjectionSemantics
} from './ssh-pty-legacy-projection'
import { SshPtyModelAdmission } from './ssh-pty-model-admission'
import { SshPtyOutputExitDeadline } from './ssh-pty-output-exit-deadline'
import { settleSshPtyOutputExit } from './ssh-pty-output-exit'
import { SshPtyOutputGenerationGuard } from './ssh-pty-output-generation-guard'
import {
  SshPtyOutputModelMigration,
  type SshPtyOutputGenerationMigration,
  type SshPtyTrackedModelAdmission
} from './ssh-pty-output-model-migration'
import {
  SshPtyOutputSourceObligations,
  type SshPtyOutputSourceReservation
} from './ssh-pty-output-source-obligations'
import type {
  SshPtyOutputDataEvent,
  SshPtyOutputExitEvent,
  SshPtyOutputIntakeDependencies,
  SshPtyOutputIntakeOptions,
  SshPtyOutputReceipt
} from './ssh-pty-output-intake-contract'
import { outputIntakeError } from './ssh-pty-output-intake-validation'

export type {
  SshPtyOutputDataEvent,
  SshPtyOutputExitEvent,
  SshPtyOutputIntakeDependencies,
  SshPtyOutputIntakeOptions,
  SshPtyOutputReceipt
} from './ssh-pty-output-intake-contract'

export class SshPtyOutputIntake {
  private readonly projections: SshPtyLegacyProjectionLedger
  private readonly sourceObligations: SshPtyOutputSourceObligations
  private readonly generationGuard = new SshPtyOutputGenerationGuard(() => this.disposed)
  private readonly admission: SshPtyModelAdmission
  private readonly modelMigration: SshPtyOutputModelMigration
  private readonly exitDeadline: SshPtyOutputExitDeadline
  private disposed = false

  constructor(
    private readonly dependencies: SshPtyOutputIntakeDependencies,
    options: SshPtyOutputIntakeOptions = {}
  ) {
    this.sourceObligations = new SshPtyOutputSourceObligations(dependencies.publishSourceAck)
    this.projections = new SshPtyLegacyProjectionLedger({
      onSettled: (span) => this.sourceObligations.settleDesktop(span, 'renderer-parse'),
      onTransferred: (span, reason) => this.sourceObligations.transferDesktop(span, reason)
    })
    this.admission = new SshPtyModelAdmission({
      ...options,
      pauseProvider: (key) =>
        this.dependencies.pauseProvider?.(key.providerGeneration, key.ptyId) ?? false,
      resumeProvider: (key) =>
        this.dependencies.resumeProvider?.(key.providerGeneration, key.ptyId),
      closeProvider: (providerGeneration, reason) =>
        this.dependencies.closeProvider?.(providerGeneration, reason)
    })
    this.modelMigration = new SshPtyOutputModelMigration(
      this.admission,
      this.sourceObligations,
      (providerGeneration, ptyId) =>
        this.dependencies.resetModelForMigration?.(providerGeneration, ptyId)
    )
    this.exitDeadline = new SshPtyOutputExitDeadline({
      admission: this.admission,
      projections: this.projections,
      sourceObligations: this.sourceObligations,
      intake: this.dependencies,
      barrierMs: options.exitBarrierMs,
      cancellationProofMs: options.exitCancellationProofMs
    })
  }

  acceptData(event: SshPtyOutputDataEvent): Promise<SshPtyOutputReceipt> {
    try {
      this.generationGuard.validateData(event)
    } catch (error) {
      return Promise.reject(error)
    }
    let projection: LegacySshProjectionSemantics | undefined
    let sourceReservation: SshPtyOutputSourceReservation | undefined
    const key = { ptyId: event.id, providerGeneration: event.providerGeneration }
    const tracked: SshPtyTrackedModelAdmission = { key, started: false }
    const receipt = this.admission.accept(key, event.data, event.rawLength, () => {
      tracked.started = true
      const expectedSequence = this.dependencies.getModelSequence(event.id) + event.rawLength
      const reservation = this.projections.reserve({
        ptyId: event.id,
        providerGeneration: event.providerGeneration,
        ptyIncarnation: event.ptyIncarnation,
        data: event.data,
        sequenceEnd: expectedSequence,
        rawLength: event.rawLength,
        transformed: event.transformed,
        source: event.source
      })
      try {
        if (reservation.semantics.desktopSpan) {
          sourceReservation = this.sourceObligations.reserve(
            event,
            reservation.semantics.desktopSpan
          )
        }
      } catch (error) {
        this.projections.rollback(reservation)
        throw error
      }
      try {
        projection = this.projections.commit(reservation)
        if (sourceReservation) {
          this.sourceObligations.commit(
            sourceReservation,
            event.id,
            projection.identity.sequenceEnd
          )
        }
      } catch (error) {
        if (sourceReservation) {
          this.sourceObligations.rollback(sourceReservation)
        }
        if (!this.projections.rollbackCommitted(reservation)) {
          this.projections.rollback(reservation)
        }
        throw error
      }
      let model: { sequence: number; completion: Promise<void> }
      try {
        model = this.dependencies.acceptModel(event, projection)
      } catch (error) {
        if (sourceReservation) {
          this.sourceObligations.rollback(sourceReservation)
        }
        this.projections.rollbackCommitted(reservation)
        throw error
      }
      try {
        this.dependencies.project(event, projection)
      } catch {
        const id = projection.identity.projectionSemanticsId
        this.projections.transfer([id], 'projection-admission-failed')
      }
      return model
    })
    const completion = receipt.then(
      (modelReceipt) => {
        if (!projection) {
          throw outputIntakeError('ssh_projection_receipt_missing')
        }
        if (sourceReservation) {
          this.sourceObligations.settleModel(sourceReservation.span)
        }
        return Object.freeze({ ...modelReceipt, projection })
      },
      (error) => {
        if (projection) {
          this.projections.transfer(
            [projection.identity.projectionSemanticsId],
            'model-admission-failed'
          )
        }
        const code = (error as { code?: unknown }).code
        if (
          code !== 'ssh_exit_delivery_canceled' &&
          !(typeof code === 'string' && code.startsWith('ssh_model_migration_'))
        ) {
          this.dependencies.closeProvider?.(event.providerGeneration, 'model-admission-failed')
        }
        throw error
      }
    )
    tracked.completion = completion
    this.modelMigration.track(tracked)
    return completion
  }

  async acceptExit(event: SshPtyOutputExitEvent): Promise<void> {
    this.generationGuard.sealExit(event)
    await this.exitDeadline.wait(event, (validateNormalExit) =>
      this.finishExit(event, validateNormalExit)
    )
  }

  private async finishExit(
    event: SshPtyOutputExitEvent,
    validateNormalExit: () => void
  ): Promise<void> {
    await settleSshPtyOutputExit({
      event,
      admission: this.admission,
      projections: this.projections,
      dependencies: this.dependencies,
      validateGeneration: () => {
        this.generationGuard.validate(event)
        validateNormalExit()
      },
      prepareExit: () => this.exitDeadline.prepareExitOnce(event),
      afterAdmissionIdle: () => this.sourceObligations.sealPty(event),
      waitForSourceTerminal: () => this.sourceObligations.whenPtyTerminal(event),
      beforeFinalize: () => this.sourceObligations.markExitPublished(event)
    })
  }

  publishProjectionPrefix(
    ids: readonly string[],
    displayChars: number,
    accountingChars: number
  ): void {
    this.projections.publishPrefix(ids, displayChars, accountingChars)
  }

  settleProjectionPrefix(ptyId: string, accountingChars: number): number {
    return this.projections.settlePublishedPrefix(ptyId, accountingChars)
  }

  transferProjections(ids: readonly string[], reason: string): number {
    return this.projections.transfer(ids, reason)
  }

  transferPtyProjections(ptyId: string, reason: string): number {
    return this.projections.transferPty(ptyId, reason)
  }

  hasProjectionFromGeneration(ids: readonly string[], providerGeneration: number): boolean {
    return ids.some(
      (id) => this.projections.get(id)?.identity.providerGeneration === providerGeneration
    )
  }

  hasUnpublishedProjection(id: string): boolean {
    return this.projections.hasUnpublished(id)
  }

  closeGeneration(providerGeneration: number, reason: string): void {
    this.generationGuard.closeGeneration(providerGeneration)
    this.admission.closeGeneration(providerGeneration, reason)
    this.dependencies.onGenerationClosed?.(providerGeneration, reason)
    this.projections.closeGeneration(providerGeneration, reason)
    this.sourceObligations.closeGeneration(providerGeneration, reason)
    this.exitDeadline.closeGeneration(providerGeneration, outputIntakeError(reason))
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const generation of this.generationGuard.activeGenerations()) {
      this.closeGeneration(generation, 'ssh_output_intake_disposed')
    }
    this.admission.dispose()
    this.sourceObligations.dispose()
  }

  getRemoteSourceRangeConsumerHooks() {
    return this.sourceObligations.remoteHooks
  }

  getAcceptedSourceCheckpoints(providerGeneration: number) {
    return this.sourceObligations.acceptedCheckpoints(providerGeneration)
  }

  beginGenerationMigration(
    providerGeneration: number,
    timeoutMs?: number
  ): SshPtyOutputGenerationMigration {
    return this.modelMigration.beginGeneration(providerGeneration, timeoutMs)
  }

  applySourceCancellationProof(
    event: SshPtyOutputExitEvent,
    proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
  ): boolean {
    return this.sourceObligations.applyCancellationProof(event, proof)
  }

  applySourceRecoveryCancellationProof(
    event: SshPtyOutputExitEvent,
    proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
  ): void {
    this.sourceObligations.applyRecoveryCancellationProof(event, proof)
  }

  getDebugSnapshot() {
    return {
      model: this.admission.getDebugSnapshot(),
      projection: this.projections.getDebugSnapshot(),
      source: this.sourceObligations.getDebugSnapshot(),
      generation: this.generationGuard.getDebugSnapshot(),
      exitBarriers: this.exitDeadline.activeBarriers
    }
  }
}
