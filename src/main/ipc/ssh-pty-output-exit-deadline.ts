import type { SshPtyLegacyProjectionLedger } from './ssh-pty-legacy-projection'
import type { SshPtyModelAdmission } from './ssh-pty-model-admission'
import type {
  SshPtyOutputExitEvent,
  SshPtyOutputIntakeDependencies
} from './ssh-pty-output-intake-contract'
import { outputIntakeError, type SshPtyExitBarrier } from './ssh-pty-output-intake-validation'
import type {
  SshPtyOutputSourceObligations,
  SshPtySourceCancellationProofCommit
} from './ssh-pty-output-source-obligations'

type SshPtyOutputExitDeadlineDependencies = Readonly<{
  admission: SshPtyModelAdmission
  projections: SshPtyLegacyProjectionLedger
  sourceObligations: SshPtyOutputSourceObligations
  intake: SshPtyOutputIntakeDependencies
  barrierMs?: number
  cancellationProofMs?: number
}>

export class SshPtyOutputExitDeadline {
  private readonly barriersByGeneration = new Map<number, Set<SshPtyExitBarrier>>()
  private readonly preparedExits = new Set<string>()
  private readonly preparedExitReleases = new Map<string, () => void>()
  private readonly barrierMs: number
  private readonly cancellationProofMs: number

  constructor(private readonly dependencies: SshPtyOutputExitDeadlineDependencies) {
    this.barrierMs = dependencies.barrierMs ?? 30_000
    this.cancellationProofMs = dependencies.cancellationProofMs ?? 10_000
  }

  wait(
    event: SshPtyOutputExitEvent,
    start: (validateNormalExit: () => void) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timeoutStarted = false
      let settled = false
      const validateNormalExit = (): void => {
        if (timeoutStarted) {
          throw outputIntakeError('ssh_exit_delivery_canceled')
        }
      }
      const settle = (result: { ok: true } | { ok: false; error: Error }): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(barrier.timer)
        this.releasePreparedExit(event)
        this.remove(event.providerGeneration, barrier)
        if (result.ok) {
          resolve()
        } else {
          reject(result.error)
        }
      }
      const barrier: SshPtyExitBarrier = {
        timer: setTimeout(() => {
          timeoutStarted = true
          void this.cancelTimedOutExit(event, barrier).then(
            () => settle({ ok: true }),
            (error) => {
              this.dependencies.intake.closeProvider?.(
                event.providerGeneration,
                'ssh-exit-cancellation-proof-failed'
              )
              settle({
                ok: false,
                error: error instanceof Error ? error : outputIntakeError(String(error))
              })
            }
          )
        }, this.barrierMs),
        reject: (error) => settle({ ok: false, error })
      }
      barrier.timer.unref?.()
      let barriers = this.barriersByGeneration.get(event.providerGeneration)
      if (!barriers) {
        barriers = new Set()
        this.barriersByGeneration.set(event.providerGeneration, barriers)
      }
      barriers.add(barrier)
      const promise = start(validateNormalExit)
      void promise.then(
        () => {
          if (!timeoutStarted) {
            settle({ ok: true })
          }
        },
        (error) => {
          if (!timeoutStarted) {
            settle({ ok: false, error })
          }
        }
      )
    })
  }

  closeGeneration(providerGeneration: number, error: Error): void {
    const barriers = this.barriersByGeneration.get(providerGeneration)
    if (barriers) {
      for (const barrier of barriers) {
        clearTimeout(barrier.timer)
        barrier.reject(error)
      }
      this.barriersByGeneration.delete(providerGeneration)
    }
    const prefix = `${providerGeneration}\0`
    for (const key of this.preparedExits) {
      if (key.startsWith(prefix)) {
        this.releasePreparedExitKey(key)
        this.preparedExits.delete(key)
      }
    }
  }

  prepareExitOnce(event: SshPtyOutputExitEvent): void {
    const key = this.exitKey(event)
    if (this.preparedExits.has(key)) {
      return
    }
    const release = this.dependencies.intake.prepareExit(event)
    this.preparedExits.add(key)
    if (release) {
      this.preparedExitReleases.set(key, release)
    }
  }

  get activeBarriers(): number {
    return Array.from(this.barriersByGeneration.values()).reduce(
      (total, barriers) => total + barriers.size,
      0
    )
  }

  private async cancelTimedOutExit(
    event: SshPtyOutputExitEvent,
    barrier: SshPtyExitBarrier
  ): Promise<void> {
    const cancel = this.dependencies.intake.cancelSourceDelivery
    if (!cancel) {
      throw outputIntakeError('ssh_source_cancellation_publisher_unavailable')
    }
    this.dependencies.admission.cancelPty(
      { ptyId: event.id, providerGeneration: event.providerGeneration },
      'ssh_exit_delivery_canceled'
    )
    this.dependencies.sourceObligations.sealPty(event)
    const cancellation = this.dependencies.sourceObligations.requestPtyCancellationProof(
      event,
      (request) => cancel(event.providerGeneration, request)
    )
    let commit: SshPtySourceCancellationProofCommit | null
    try {
      commit = await this.withCancellationProofDeadline(cancellation)
    } catch (error) {
      if (!this.isActive(event.providerGeneration, barrier)) {
        return
      }
      throw error
    }
    if (!this.isActive(event.providerGeneration, barrier)) {
      return
    }
    if (!commit) {
      throw outputIntakeError('ssh_source_cancellation_identity_unavailable')
    }
    this.dependencies.projections.transferPty(event.id, 'ssh-exit-delivery-canceled')
    this.dependencies.sourceObligations.commitPtyCancellationProof(commit)
    this.prepareExitOnce(event)
    if (!this.isActive(event.providerGeneration, barrier)) {
      return
    }
    this.dependencies.intake.finalizeExit(event)
    if (!this.isActive(event.providerGeneration, barrier)) {
      return
    }
    this.dependencies.projections.closePty(
      event.id,
      event.providerGeneration,
      event.ptyIncarnation,
      'ssh-exit-delivery-canceled'
    )
  }

  private isActive(providerGeneration: number, barrier: SshPtyExitBarrier): boolean {
    return this.barriersByGeneration.get(providerGeneration)?.has(barrier) ?? false
  }

  private exitKey(event: SshPtyOutputExitEvent): string {
    return `${event.providerGeneration}\0${event.id}\0${event.ptyIncarnation}`
  }

  private releasePreparedExit(event: SshPtyOutputExitEvent): void {
    const key = this.exitKey(event)
    this.preparedExits.delete(key)
    this.releasePreparedExitKey(key)
  }

  private releasePreparedExitKey(key: string): void {
    const release = this.preparedExitReleases.get(key)
    if (!release) {
      return
    }
    this.preparedExitReleases.delete(key)
    release()
  }

  private withCancellationProofDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(outputIntakeError('ssh_source_cancellation_proof_timeout')),
        this.cancellationProofMs
      )
      timer.unref?.()
      void promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private remove(providerGeneration: number, barrier: SshPtyExitBarrier): void {
    const barriers = this.barriersByGeneration.get(providerGeneration)
    barriers?.delete(barrier)
    if (barriers?.size === 0) {
      this.barriersByGeneration.delete(providerGeneration)
    }
  }
}
