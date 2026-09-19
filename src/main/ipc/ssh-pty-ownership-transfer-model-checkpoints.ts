import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-output-source-obligations'
import type { LegacySshProjectionSemantics } from './ssh-pty-legacy-projection'
import type {
  SshPtyOutputDataEvent,
  SshPtyOutputIntakeDependencies
} from './ssh-pty-output-intake-contract'
import { outputIntakeError } from './ssh-pty-output-intake-validation'

export const MAX_SSH_PTY_OWNERSHIP_TRANSFER_MODEL_CHECKPOINTS = 4096

type CheckpointAttempt = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  observed: boolean
  status: 'pending' | 'fulfilled' | 'failed'
}

type CheckpointRecord = {
  range: SshPtyOwnershipTransferSourceRange
  attempt: CheckpointAttempt
  releaseWhenFulfilled: boolean
}

/** Rendezvous between complete destination frames and normal SSH model admission. */
export class SshPtyOwnershipTransferModelCheckpoints {
  private readonly records = new Map<string, CheckpointRecord>()

  constructor(
    readonly enabled: boolean,
    private readonly checkpoint: SshPtyOutputIntakeDependencies['checkpointOwnershipTransferModel']
  ) {}

  rangeFor(event: SshPtyOutputDataEvent): SshPtyOwnershipTransferSourceRange | undefined {
    if (!this.enabled || !event.source?.ownershipTransfer) {
      return undefined
    }
    return ownershipTransferSourceRange(event)
  }

  accept(
    range: SshPtyOwnershipTransferSourceRange | undefined,
    event: SshPtyOutputDataEvent,
    projection: LegacySshProjectionSemantics,
    acceptModel: () => { sequence: number; completion: Promise<void> }
  ): { sequence: number; completion: Promise<void> } {
    if (!range) {
      return acceptModel()
    }
    if (!this.checkpoint) {
      throw outputIntakeError('ssh_ownership_transfer_model_checkpoint_unavailable')
    }
    const accepted = acceptModel()
    const completion = accepted.completion.then(() =>
      this.checkpoint!({ event, projection, modelSequenceEnd: accepted.sequence })
    )
    this.observe(range, completion)
    return { sequence: accepted.sequence, completion }
  }

  observe(range: SshPtyOwnershipTransferSourceRange, completion: Promise<unknown>): void {
    const record = this.getOrCreate(range)
    if (record.attempt.status === 'fulfilled') {
      return
    }
    if (record.attempt.status === 'failed') {
      record.attempt = createAttempt()
    }
    if (record.attempt.observed) {
      throw outputIntakeError('ssh_ownership_transfer_model_checkpoint_duplicate')
    }
    const attempt = record.attempt
    attempt.observed = true
    void completion.then(
      () => {
        if (record.attempt !== attempt || attempt.status !== 'pending') {
          return
        }
        attempt.status = 'fulfilled'
        attempt.resolve()
        if (record.releaseWhenFulfilled) {
          this.records.delete(checkpointKey(record.range))
        }
      },
      (error) => {
        if (record.attempt !== attempt || attempt.status !== 'pending') {
          return
        }
        attempt.status = 'failed'
        attempt.reject(asError(error))
      }
    )
  }

  fail(range: SshPtyOwnershipTransferSourceRange, error: unknown): void {
    const record = this.getOrCreate(range)
    if (record.attempt.status !== 'pending') {
      return
    }
    record.attempt.status = 'failed'
    record.attempt.reject(asError(error))
  }

  release(range: SshPtyOwnershipTransferSourceRange): void {
    const key = checkpointKey(range)
    const record = this.records.get(key)
    if (!record) {
      return
    }
    requireSameRange(record.range, range)
    if (record.attempt.status === 'fulfilled') {
      this.records.delete(key)
      return
    }
    record.releaseWhenFulfilled = true
  }

  waitFor(ranges: readonly SshPtyOwnershipTransferSourceRange[]): Promise<void> {
    if (!this.enabled) {
      return Promise.reject(outputIntakeError('ssh_ownership_transfer_model_checkpoint_disabled'))
    }
    if (ranges.length === 0) {
      return Promise.reject(
        outputIntakeError('ssh_ownership_transfer_model_checkpoint_ranges_empty')
      )
    }
    const promises: Promise<void>[] = []
    const keys = new Set<string>()
    for (const range of ranges) {
      const key = checkpointKey(range)
      if (keys.has(key)) {
        const existing = this.records.get(key)
        if (existing) {
          requireSameRange(existing.range, range)
        }
        continue
      }
      keys.add(key)
      const record = this.getOrCreate(range)
      if (record.attempt.status === 'failed') {
        record.attempt = createAttempt()
      }
      promises.push(record.attempt.promise)
    }
    return Promise.all(promises).then(() => undefined)
  }

  closeGeneration(providerGeneration: number, reason: string): void {
    const error = outputIntakeError(reason)
    for (const [key, record] of this.records) {
      if (record.range.providerGeneration !== providerGeneration) {
        continue
      }
      if (record.attempt.status === 'pending') {
        record.attempt.status = 'failed'
        record.attempt.reject(error)
      }
      this.records.delete(key)
    }
  }

  dispose(): void {
    const generations = new Set(
      [...this.records.values()].map((record) => record.range.providerGeneration)
    )
    for (const generation of generations) {
      this.closeGeneration(generation, 'ssh_ownership_transfer_model_checkpoint_disposed')
    }
  }

  get size(): number {
    return this.records.size
  }

  private getOrCreate(range: SshPtyOwnershipTransferSourceRange): CheckpointRecord {
    const key = checkpointKey(range)
    const existing = this.records.get(key)
    if (existing) {
      requireSameRange(existing.range, range)
      return existing
    }
    if (this.records.size >= MAX_SSH_PTY_OWNERSHIP_TRANSFER_MODEL_CHECKPOINTS) {
      throw outputIntakeError('ssh_ownership_transfer_model_checkpoint_capacity')
    }
    const record = {
      range: Object.freeze({ ...range }),
      attempt: createAttempt(),
      releaseWhenFulfilled: false
    }
    this.records.set(key, record)
    return record
  }
}

function createAttempt(): CheckpointAttempt {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  void promise.catch(() => {})
  return { promise, resolve, reject, observed: false, status: 'pending' }
}

function checkpointKey(range: SshPtyOwnershipTransferSourceRange): string {
  return `${range.providerGeneration}\0${range.relayPtyId}\0${range.deliveryToken}\0${range.spanId}\0${range.ownershipTransfer.bridgeId}`
}

function requireSameRange(
  left: SshPtyOwnershipTransferSourceRange,
  right: SshPtyOwnershipTransferSourceRange
): void {
  if (
    left.providerGeneration !== right.providerGeneration ||
    left.relayPtyId !== right.relayPtyId ||
    left.spanId !== right.spanId ||
    left.clientGeneration !== right.clientGeneration ||
    left.ownerGeneration !== right.ownerGeneration ||
    left.deliveryToken !== right.deliveryToken ||
    left.ptyIncarnation !== right.ptyIncarnation ||
    left.sourceStartSu !== right.sourceStartSu ||
    left.sourceEndSu !== right.sourceEndSu ||
    !sameTransfer(left.ownershipTransfer, right.ownershipTransfer)
  ) {
    throw outputIntakeError('ssh_ownership_transfer_model_checkpoint_conflict')
  }
}

function sameTransfer(
  left: SshPtyOwnershipTransferSourceRange['ownershipTransfer'],
  right: SshPtyOwnershipTransferSourceRange['ownershipTransfer']
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId &&
    left.version === right.version &&
    left.frameSeq === right.frameSeq &&
    left.fragmentStartSu === right.fragmentStartSu &&
    left.fragmentEndSu === right.fragmentEndSu &&
    left.frameLengthSu === right.frameLengthSu
  )
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function ownershipTransferSourceRange(
  event: SshPtyOutputDataEvent
): SshPtyOwnershipTransferSourceRange {
  const source = event.source
  const ownershipTransfer = source?.ownershipTransfer
  if (!source || !ownershipTransfer || !source.relayPtyId) {
    throw outputIntakeError('ssh_ownership_transfer_model_checkpoint_source_invalid')
  }
  return Object.freeze({
    providerGeneration: event.providerGeneration,
    relayPtyId: source.relayPtyId,
    spanId: source.spanId,
    clientGeneration: source.clientGeneration,
    ownerGeneration: source.ownerGeneration,
    deliveryToken: source.deliveryToken,
    ptyIncarnation: event.ptyIncarnation,
    sourceStartSu: source.sourceStartSu,
    sourceEndSu: source.sourceEndSu,
    ownershipTransfer
  })
}
