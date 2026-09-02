import type { SshPtyOutputDataEvent, SshPtyOutputExitEvent } from './ssh-pty-output-intake-contract'
import {
  outputIntakeError,
  sshPtyGenerationKey,
  validOutputLength
} from './ssh-pty-output-intake-validation'
import { SshPtyClosedGenerationRanges } from './ssh-pty-closed-generation-ranges'

export class SshPtyOutputGenerationGuard {
  private readonly latestGenerationByPty = new Map<string, number>()
  private readonly incarnationByPty = new Map<string, string>()
  private readonly sealedPtys = new Set<string>()
  private readonly closedGenerations = new SshPtyClosedGenerationRanges()

  constructor(private readonly isDisposed: () => boolean) {}

  validateData(event: SshPtyOutputDataEvent): void {
    if (
      !event.id ||
      !event.ptyIncarnation ||
      !Number.isSafeInteger(event.providerGeneration) ||
      event.providerGeneration <= 0 ||
      !validOutputLength(event.rawLength) ||
      (event.source !== undefined &&
        (!event.source.spanId ||
          !event.source.deliveryToken ||
          !Number.isSafeInteger(event.source.clientGeneration) ||
          event.source.clientGeneration <= 0 ||
          !Number.isSafeInteger(event.source.ownerGeneration) ||
          event.source.ownerGeneration <= 0 ||
          !Number.isSafeInteger(event.source.sourceStartSu) ||
          event.source.sourceStartSu < 0 ||
          !Number.isSafeInteger(event.source.sourceEndSu) ||
          event.source.sourceEndSu - event.source.sourceStartSu !== event.rawLength))
    ) {
      throw outputIntakeError('ssh_output_invalid_event')
    }
    this.validate(event)
    if (this.sealedPtys.has(sshPtyGenerationKey(event.id, event.providerGeneration))) {
      throw outputIntakeError('ssh_output_after_exit')
    }
  }

  sealExit(event: SshPtyOutputExitEvent): void {
    this.validate(event)
    const key = sshPtyGenerationKey(event.id, event.providerGeneration)
    if (this.sealedPtys.has(key)) {
      throw outputIntakeError('ssh_output_duplicate_exit')
    }
    this.sealedPtys.add(key)
  }

  validate(event: { id: string; providerGeneration: number; ptyIncarnation: string }): void {
    if (this.isDisposed()) {
      throw outputIntakeError('ssh_output_intake_disposed')
    }
    if (this.closedGenerations.has(event.providerGeneration)) {
      throw outputIntakeError('ssh_output_stale_generation')
    }
    const generation = this.latestGenerationByPty.get(event.id)
    if (generation !== undefined && event.providerGeneration < generation) {
      throw outputIntakeError('ssh_output_stale_generation')
    }
    const incarnation = this.incarnationByPty.get(event.id)
    if (
      generation === event.providerGeneration &&
      incarnation !== undefined &&
      incarnation !== event.ptyIncarnation
    ) {
      throw outputIntakeError('ssh_output_stale_incarnation')
    }
    if (generation === undefined || event.providerGeneration > generation) {
      this.latestGenerationByPty.set(event.id, event.providerGeneration)
      this.incarnationByPty.set(event.id, event.ptyIncarnation)
    }
  }

  closeGeneration(providerGeneration: number): void {
    this.closedGenerations.add(providerGeneration)
    for (const [ptyId, generation] of this.latestGenerationByPty) {
      if (generation === providerGeneration) {
        this.latestGenerationByPty.delete(ptyId)
        this.incarnationByPty.delete(ptyId)
        this.sealedPtys.delete(sshPtyGenerationKey(ptyId, generation))
      }
    }
    const prefix = `${providerGeneration}\0`
    for (const key of this.sealedPtys) {
      if (key.startsWith(prefix)) {
        this.sealedPtys.delete(key)
      }
    }
  }

  activeGenerations(): ReadonlySet<number> {
    return new Set(this.latestGenerationByPty.values())
  }

  getDebugSnapshot() {
    return {
      closedRanges: this.closedGenerations.size,
      activeGaps: this.closedGenerations.activeGaps,
      activePtys: this.latestGenerationByPty.size,
      sealedPtys: this.sealedPtys.size
    }
  }
}
