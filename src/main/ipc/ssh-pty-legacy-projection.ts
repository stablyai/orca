import { scanMode2031ReplyDecision } from '../../shared/terminal-color-scheme-protocol'
import {
  closeProjectionPty,
  getOrCreateProjectionCursor,
  projectionDebugSnapshot,
  projectionError,
  reclaimProjectionRecord,
  resetProjectionCursorForGap,
  requireProjectionRecord,
  rollbackCommittedProjectionRecord,
  scannerSnapshot,
  type DesktopProjectionSpan,
  type LegacySshProjectionDebugSnapshot,
  type LegacySshProjectionReservation,
  type LegacySshProjectionSemantics,
  type ProjectionRecord,
  type PtyProjectionCursor
} from './ssh-pty-legacy-projection-record'
import {
  projectionHasOpen,
  resolveProjectionTerminality,
  SshPtyProjectionTerminality,
  unpublishedProjectionIds
} from './ssh-pty-projection-terminality'
import {
  hasUnpublishedLegacyProjection,
  publishLegacyProjectionPrefix,
  settlePublishedLegacyProjectionPrefix
} from './ssh-pty-legacy-projection-publication'

export type {
  DesktopProjectionSpan,
  LegacySshProjectionIdentity,
  LegacySshProjectionReservation,
  LegacySshProjectionSemantics
} from './ssh-pty-legacy-projection-record'

export type SshPtyLegacyProjectionLedgerOptions = {
  onSettled?: (span: DesktopProjectionSpan, reason: string) => void
  onTransferred?: (span: DesktopProjectionSpan, reason: string) => void
}

export class SshPtyLegacyProjectionLedger {
  private nextId = 1
  private readonly records = new Map<string, ProjectionRecord>()
  private readonly cursorByPty = new Map<string, PtyProjectionCursor>()
  private readonly idsByPty = new Map<string, string[]>()
  private readonly terminality = new SshPtyProjectionTerminality()
  private settledCount = 0
  private transferredCount = 0
  private rolledBackCount = 0

  constructor(private readonly options: SshPtyLegacyProjectionLedgerOptions = {}) {}

  reserve(args: {
    ptyId: string
    providerGeneration: number
    ptyIncarnation: string
    data: string
    sequenceEnd: number
    rawLength: number
    transformed: boolean
    source?: Readonly<{
      relayPtyId?: string
      spanId: string
      clientGeneration: number
      ownerGeneration: number
      deliveryToken: string
      sourceStartSu: number
      sourceEndSu: number
    }>
  }): LegacySshProjectionReservation {
    const cursor = getOrCreateProjectionCursor(this.cursorByPty, args, (generation) =>
      this.transferGeneration(generation, 'provider-generation-replaced')
    )
    if (
      cursor.providerGeneration !== args.providerGeneration ||
      cursor.ptyIncarnation !== args.ptyIncarnation
    ) {
      throw projectionError('ssh_projection_stale_generation')
    }
    const scan = scanMode2031ReplyDecision(cursor.scanner, args.data)
    const projectionSemanticsId = `ssh-projection:${args.providerGeneration}:${this.nextId++}`
    const identity = Object.freeze({
      projectionSemanticsId,
      ptyId: args.ptyId,
      providerGeneration: args.providerGeneration,
      ptyIncarnation: args.ptyIncarnation,
      displayStart: cursor.displayEnd,
      displayEnd: cursor.displayEnd + args.data.length,
      sequenceEnd: args.sequenceEnd,
      rawLength: args.rawLength,
      transformed: args.transformed
    })
    const semantics = Object.freeze({
      identity,
      ...(args.source
        ? {
            desktopSpan: Object.freeze({
              ...args.source,
              id: args.source.relayPtyId ?? args.ptyId,
              projectionSemanticsId,
              providerGeneration: args.providerGeneration,
              ptyIncarnation: args.ptyIncarnation,
              displayStart: identity.displayStart,
              displayEnd: identity.displayEnd,
              splittable: !args.transformed,
              transform: Object.freeze({
                transformed: args.transformed,
                rawLengthSu: args.rawLength,
                scalarSafe: !args.transformed
              })
            })
          }
        : {}),
      beforeScanner: scannerSnapshot(cursor.scanner),
      afterScanner: scannerSnapshot(scan.state),
      decision: scan.decision
    })
    this.records.set(projectionSemanticsId, {
      semantics,
      state: 'reserved',
      publishedDisplay: 0,
      publishedAccounting: 0,
      settledAccounting: 0
    })
    return Object.freeze({ semantics })
  }

  commit(reservation: LegacySshProjectionReservation): LegacySshProjectionSemantics {
    const record = requireProjectionRecord(
      this.records,
      reservation.semantics.identity.projectionSemanticsId
    )
    if (record.state !== 'reserved') {
      throw projectionError('ssh_projection_commit_invalid')
    }
    const { identity, afterScanner } = record.semantics
    const cursor = this.cursorByPty.get(identity.ptyId)
    if (
      !cursor ||
      cursor.providerGeneration !== identity.providerGeneration ||
      cursor.ptyIncarnation !== identity.ptyIncarnation ||
      cursor.displayEnd !== identity.displayStart
    ) {
      this.records.delete(identity.projectionSemanticsId)
      throw projectionError('ssh_projection_commit_stale')
    }
    cursor.displayEnd = identity.displayEnd
    cursor.scanner = { ...afterScanner }
    record.state = 'committed'
    const ids = this.idsByPty.get(identity.ptyId) ?? []
    ids.push(identity.projectionSemanticsId)
    this.idsByPty.set(identity.ptyId, ids)
    return record.semantics
  }

  rollback(reservation: LegacySshProjectionReservation): boolean {
    const id = reservation.semantics.identity.projectionSemanticsId
    const record = this.records.get(id)
    if (!record || record.state !== 'reserved') {
      return false
    }
    this.records.delete(id)
    this.rolledBackCount++
    return true
  }

  rollbackCommitted(reservation: LegacySshProjectionReservation): boolean {
    const ptyId = rollbackCommittedProjectionRecord(
      this.records,
      this.idsByPty,
      this.cursorByPty,
      reservation
    )
    if (!ptyId) {
      return false
    }
    this.rolledBackCount++
    resolveProjectionTerminality(this.terminality, this.records, this.idsByPty, ptyId)
    return true
  }

  publishPrefix(ids: readonly string[], displayChars: number, accountingChars: number): void {
    publishLegacyProjectionPrefix(this.records, ids, displayChars, accountingChars)
  }

  settlePublishedPrefix(ptyId: string, accountingChars: number): number {
    const result = settlePublishedLegacyProjectionPrefix(
      this.records,
      this.idsByPty,
      ptyId,
      accountingChars,
      this.options.onSettled
    )
    this.settledCount += result.completed
    resolveProjectionTerminality(this.terminality, this.records, this.idsByPty, ptyId)
    return result.settled
  }

  transfer(ids: readonly string[], reason: string): number {
    let transferred = 0
    const touchedPtys = new Set<string>()
    for (const id of ids.slice()) {
      const record = this.records.get(id)
      if (!record || record.state === 'reserved') {
        continue
      }
      const ptyId = record.semantics.identity.ptyId
      if (record.semantics.desktopSpan) {
        this.options.onTransferred?.(record.semantics.desktopSpan, reason)
      }
      this.transferredCount++
      reclaimProjectionRecord(this.records, this.idsByPty, id, ptyId)
      touchedPtys.add(ptyId)
      transferred++
    }
    for (const ptyId of touchedPtys) {
      resolveProjectionTerminality(this.terminality, this.records, this.idsByPty, ptyId)
    }
    return transferred
  }

  whenPtyTerminal(
    ptyId: string,
    providerGeneration: number,
    ptyIncarnation: string
  ): Promise<void> {
    return this.terminality.whenTerminal(
      ptyId,
      providerGeneration,
      ptyIncarnation,
      projectionHasOpen(this.records, this.idsByPty, ptyId)
    )
  }

  transferGeneration(providerGeneration: number, reason: string): number {
    const ids: string[] = []
    for (const [id, record] of this.records) {
      if (record.semantics.identity.providerGeneration === providerGeneration) {
        ids.push(id)
      }
    }
    return this.transfer(ids, reason)
  }

  transferPty(ptyId: string, reason: string): number {
    return this.transfer(this.idsByPty.get(ptyId) ?? [], reason)
  }

  transferUnpublishedPty(
    ptyId: string,
    providerGeneration: number,
    ptyIncarnation: string,
    reason: string
  ): number {
    const ids = unpublishedProjectionIds(
      this.records,
      this.idsByPty.get(ptyId) ?? [],
      providerGeneration,
      ptyIncarnation
    )
    return this.transfer(ids, reason)
  }

  closePty(
    ptyId: string,
    providerGeneration: number,
    ptyIncarnation: string,
    reason: string
  ): void {
    closeProjectionPty(this.cursorByPty, ptyId, providerGeneration, ptyIncarnation, () => {
      this.transferPty(ptyId, reason)
      this.idsByPty.delete(ptyId)
    })
  }

  closeGeneration(providerGeneration: number, reason: string): void {
    for (const [id, record] of this.records) {
      if (record.semantics.identity.providerGeneration !== providerGeneration) {
        continue
      }
      if (record.state === 'reserved') {
        this.records.delete(id)
        this.rolledBackCount++
      } else {
        this.transfer([id], reason)
      }
    }
    for (const [ptyId, cursor] of this.cursorByPty) {
      if (cursor.providerGeneration === providerGeneration) {
        this.cursorByPty.delete(ptyId)
        this.idsByPty.delete(ptyId)
      }
    }
    this.terminality.closeGeneration(providerGeneration)
  }

  resetForGap(ptyId: string): void {
    resetProjectionCursorForGap(this.cursorByPty, ptyId)
  }

  get(id: string): LegacySshProjectionSemantics | undefined {
    return this.records.get(id)?.semantics
  }

  hasUnpublished(id: string): boolean {
    return hasUnpublishedLegacyProjection(this.records, id)
  }

  getDebugSnapshot(): LegacySshProjectionDebugSnapshot {
    return projectionDebugSnapshot(this.records, this.cursorByPty, {
      settled: this.settledCount,
      transferred: this.transferredCount,
      rolledBack: this.rolledBackCount
    })
  }
}
