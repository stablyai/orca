import type {
  AgentJournalItemBody,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import {
  dispatchReservationId,
  JournalLifecycleCapacity,
  lifecycleReservationIdForItem,
  requiresTerminalSettlement,
  terminalReservationBytes,
  type JournalLifecycleReservation
} from './journal-lifecycle-capacity'
import type { JournalRow } from './journal-row-schema'
import { journalRowByteLength } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalLifecycleRowAdmission = {
  releaseAfter: string[]
  protectedBytes: number
  lifecycleCovered: boolean
  proposedCapacity: JournalLifecycleCapacity
}

export class JournalLifecycleAdmission {
  private readonly capacity = new JournalLifecycleCapacity()

  constructor(
    private readonly sessionId: string,
    private readonly maxBytes: number,
    private readonly canonicalItemId: (itemId: string) => string,
    private readonly maxAppendSlots = Number.MAX_SAFE_INTEGER
  ) {}

  get state(): { reservedBytes: number; reservedAppendSlots: number } {
    return {
      reservedBytes: this.capacity.reservedBytes,
      reservedAppendSlots: this.capacity.reservedAppendSlots
    }
  }

  rebuild(snapshot: AgentJournalSnapshot, currentPhysicalBytes: number): void {
    if (
      !this.capacity.rebuild(snapshot, this.maxBytes, currentPhysicalBytes, this.maxAppendSlots)
    ) {
      throw this.capacityError('cannot rebuild lifecycle capacity')
    }
  }

  reserve(token: JournalLifecycleReservation, currentPhysicalBytes: number): boolean {
    return this.capacity.reserve(token, currentPhysicalBytes, this.maxBytes, this.maxAppendSlots)
  }

  transfer(fromId: string, toId: string): boolean {
    return this.capacity.transfer(fromId, toId)
  }

  release(id: string): void {
    this.capacity.release(id)
  }

  prepare(row: JournalRow, currentPhysicalBytes: number): JournalLifecycleRowAdmission {
    const proposedCapacity = this.capacity.clone()
    this.ensureActionable(row, currentPhysicalBytes, proposedCapacity)
    const releaseAfter = this.reservationsSettledBy(row, proposedCapacity)
    const releasedBytes = releaseAfter.reduce(
      (total, id) => total + (proposedCapacity.token(id)?.bytes ?? 0),
      0
    )
    return {
      releaseAfter,
      protectedBytes: proposedCapacity.reservedBytes - releasedBytes,
      lifecycleCovered: proposedCapacity.covers(releaseAfter, journalRowByteLength(row), 1),
      proposedCapacity
    }
  }

  commit(admission: JournalLifecycleRowAdmission): void {
    this.capacity.replaceFrom(admission.proposedCapacity)
    for (const id of admission.releaseAfter) {
      this.capacity.release(id)
    }
  }

  private ensureActionable(
    row: JournalRow,
    currentPhysicalBytes: number,
    capacity: JournalLifecycleCapacity
  ): void {
    if (row.kind === 'item') {
      this.ensureActionableItem(row.itemId, row.body, currentPhysicalBytes, capacity)
      return
    }
    if (row.kind !== 'lifecycle-batch') {
      return
    }
    for (const mutation of row.mutations) {
      if (mutation.kind === 'item') {
        this.ensureActionableItem(mutation.itemId, mutation.body, currentPhysicalBytes, capacity)
      }
    }
  }

  private ensureActionableItem(
    itemId: string,
    body: AgentJournalItemBody,
    currentPhysicalBytes: number,
    capacity: JournalLifecycleCapacity
  ): void {
    if (!requiresTerminalSettlement(body)) {
      return
    }
    const id = lifecycleReservationIdForItem(this.canonicalItemId(itemId))
    if (body.kind === 'status' && body.turnLifecycle?.state === 'running' && !capacity.has(id)) {
      capacity.claimFirst('tentative-turn:', id)
    }
    if (
      !capacity.reserve(
        { id, bytes: terminalReservationBytes(body), appendSlots: 1 },
        currentPhysicalBytes,
        this.maxBytes,
        this.maxAppendSlots
      )
    ) {
      throw this.capacityError('cannot reserve terminal capacity')
    }
  }

  private reservationsSettledBy(row: JournalRow, capacity: JournalLifecycleCapacity): string[] {
    if (row.kind === 'dispatch') {
      const id = dispatchReservationId(row.clientMessageId)
      return capacity.has(id) ? [id] : []
    }
    const itemIds =
      row.kind === 'item'
        ? requiresTerminalSettlement(row.body)
          ? []
          : [row.itemId]
        : row.kind === 'tombstone'
          ? [row.itemId]
          : row.kind === 'lifecycle-batch'
            ? row.mutations.flatMap((mutation) =>
                mutation.kind === 'item' && requiresTerminalSettlement(mutation.body)
                  ? []
                  : [mutation.itemId]
              )
            : []
    return [
      ...new Set(
        itemIds.map((itemId) => lifecycleReservationIdForItem(this.canonicalItemId(itemId)))
      )
    ].filter((id) => capacity.has(id))
  }

  private capacityError(detail: string): AgentSessionJournalError {
    return new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${this.sessionId} ${detail}`
    )
  }
}
