import type {
  RemoteTerminalSourceRangeReplacementPublication,
  RemoteTerminalSourceRangeReplacementReservation,
  RemoteTerminalSourceRangeStreamIdentity
} from '../runtime/remote-terminal-source-range-consumer'
import type { PtySourceSpan } from '../../shared/pty-source-credit-contract'
import type {
  SshPtySourceConsumerId,
  SshPtySourceObligationState
} from './ssh-pty-source-obligation-contract'
import type { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'

type ReplacementSpanRecord = Readonly<{
  source: PtySourceSpan
  transferState: SshPtySourceObligationState
}>

type ReplacementReservationRecord = {
  reservation: RemoteTerminalSourceRangeReplacementReservation
  spans: readonly ReplacementSpanRecord[]
  consumer: SshPtySourceConsumerId
  replacement: SshPtySourceConsumerId
  reason: string
}

function remoteConsumerId(
  identity: RemoteTerminalSourceRangeStreamIdentity
): SshPtySourceConsumerId {
  return `remote:${identity.consumerId}`
}

export class SshPtyRemoteSourceRangeReplacements {
  private readonly reservations = new Map<string, ReplacementReservationRecord>()
  private nextReservationId = 1

  constructor(private readonly coordinator: SshPtySourceObligationCoordinator) {}

  reserve(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    spanIds: readonly string[],
    requiredSeq: number,
    reason: string
  ): RemoteTerminalSourceRangeReplacementReservation | null {
    if (spanIds.length === 0) {
      return null
    }
    if (!Number.isSafeInteger(requiredSeq) || requiredSeq < 0) {
      throw new Error('ssh_remote_source_range_replacement_sequence_invalid')
    }
    const consumer = remoteConsumerId(identity)
    const replacement = `remote:snapshot:${identity.consumerId}` as const
    const spans = spanIds.map((spanId) => this.coordinator.spanIdentity(spanId))
    for (const { spanId } of spans) {
      if (this.coordinator.obligation(spanId, consumer).state !== 'open') {
        throw new Error('ssh_remote_source_range_transfer_invalid')
      }
    }
    const transferred: ReplacementSpanRecord[] = []
    try {
      for (const source of spans) {
        const { spanId } = source
        const transition = { identity: source, spanId, consumer, reason }
        if (!this.coordinator.beginTransfer(transition, replacement)) {
          throw new Error('ssh_remote_source_range_transfer_invalid')
        }
        const transferState = this.coordinator.obligation(spanId, consumer)
        if (transferState.state !== 'transferring' || transferState.to !== replacement) {
          this.coordinator.rollbackTransfer(transition)
          throw new Error('ssh_remote_source_range_transfer_invalid')
        }
        transferred.push(Object.freeze({ source, transferState }))
      }
    } catch (error) {
      for (const span of transferred.toReversed()) {
        this.rollbackExactSpan(span, consumer, reason)
      }
      throw error
    }
    const reservation = Object.freeze({
      reservationId: `remote-source-replacement:${this.nextReservationId++}`,
      identity: Object.freeze({ ...identity }),
      requiredSeq
    })
    this.reservations.set(reservation.reservationId, {
      reservation,
      spans: Object.freeze(transferred),
      consumer,
      replacement,
      reason
    })
    return reservation
  }

  commit(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication,
    isCurrent: boolean,
    onCommitted: (spanIds: readonly string[]) => void
  ): boolean {
    const record = this.reservations.get(reservation.reservationId)
    if (
      !record ||
      record.reservation !== reservation ||
      !isCurrent ||
      !Number.isSafeInteger(publication.seq) ||
      publication.seq < reservation.requiredSeq ||
      (publication.source !== 'headless' && publication.source !== 'renderer')
    ) {
      return false
    }
    if (
      record.spans.some(({ source, transferState }) => {
        const { spanId } = source
        if (!this.coordinator.hasRetainedSpan(spanId)) {
          return true
        }
        return this.coordinator.obligation(spanId, record.consumer) !== transferState
      })
    ) {
      return false
    }
    for (const { source } of record.spans) {
      const { spanId } = source
      if (!this.coordinator.hasRetainedSpan(spanId)) {
        continue
      }
      if (
        !this.coordinator.commitTransfer({ identity: source, spanId, consumer: record.consumer })
      ) {
        throw new Error('ssh_remote_source_range_replacement_commit_invalid')
      }
    }
    this.reservations.delete(reservation.reservationId)
    onCommitted(record.spans.map(({ source }) => source.spanId))
    return true
  }

  rollback(reservation: RemoteTerminalSourceRangeReplacementReservation, reason: string): boolean {
    const record = this.reservations.get(reservation.reservationId)
    if (!record || record.reservation !== reservation) {
      return false
    }
    this.reservations.delete(reservation.reservationId)
    let rolledBack = true
    for (const span of record.spans) {
      const { spanId } = span.source
      if (!this.coordinator.hasRetainedSpan(spanId)) {
        continue
      }
      rolledBack = this.rollbackExactSpan(span, record.consumer, reason) && rolledBack
    }
    return rolledBack
  }

  rollbackIdentity(identity: RemoteTerminalSourceRangeStreamIdentity, reason: string): void {
    for (const record of Array.from(this.reservations.values())) {
      if (
        record.reservation.identity.ptyId === identity.ptyId &&
        record.reservation.identity.consumerId === identity.consumerId &&
        record.reservation.identity.streamGeneration === identity.streamGeneration
      ) {
        this.rollback(record.reservation, reason)
      }
    }
  }

  closeGeneration(providerGeneration: number, reason: string): void {
    for (const record of Array.from(this.reservations.values())) {
      if (record.spans.some(({ source }) => source.providerGeneration === providerGeneration)) {
        this.rollback(record.reservation, `${reason}-replacement-aborted`)
      }
    }
  }

  private rollbackExactSpan(
    span: ReplacementSpanRecord,
    consumer: SshPtySourceConsumerId,
    reason: string
  ): boolean {
    const { source, transferState } = span
    if (
      !this.coordinator.hasRetainedSpan(source.spanId) ||
      this.coordinator.obligation(source.spanId, consumer) !== transferState
    ) {
      return false
    }
    return this.coordinator.rollbackTransfer({
      identity: source,
      spanId: source.spanId,
      consumer,
      reason
    })
  }
}
