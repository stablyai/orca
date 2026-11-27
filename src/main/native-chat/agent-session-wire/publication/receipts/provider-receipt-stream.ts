import { randomUUID } from 'node:crypto'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  MAX_PROVIDER_RECEIPT_REPLY_KEYS,
  type ProviderReceiptStreamUpdate,
  type ProviderReceiptUpdate
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { StructuredAgentSessionProviderReceipts } from '../../host/structured-agent-session-provider-receipts'

type Reset = { id: string; stamps: ProviderReceiptUpdate[]; offset: number }

export class ProviderReceiptStream {
  private epoch: string | undefined
  private reset: Reset | undefined
  private readonly applied = new Map<string, ProviderReceiptUpdate>()
  private changes: Set<string> | null = null

  constructor(
    readonly source: StructuredAgentSessionProviderReceipts,
    readonly sessionId: string,
    readonly subscription: string,
    readonly generation: number,
    private readonly cursor: () => AgentJournalCursor
  ) {}

  changed(id: string | null): void {
    if (id === null || this.changes?.size === MAX_PROVIDER_RECEIPT_REPLY_KEYS) {
      this.changes = null
    } else {
      this.changes?.add(id)
    }
  }

  discard(): void {
    this.epoch = undefined
    this.reset = undefined
    this.applied.clear()
    this.changes = null
  }

  prepare() {
    this.source.revalidate(this.sessionId)
    const throughCursor = this.cursor()
    if (this.epoch !== throughCursor.epoch) {
      this.epoch = throughCursor.epoch
      this.reset = {
        id: randomUUID(),
        stamps: [...this.source.snapshot(this.sessionId)],
        offset: 0
      }
      this.applied.clear()
      this.changes = new Set()
    }

    const reset = this.reset
    const frame: ProviderReceiptStreamUpdate = {
      subscription: this.subscription,
      generation: this.generation,
      sessionId: this.sessionId,
      epoch: throughCursor.epoch,
      throughCursor,
      reset: reset ? { id: reset.id, offset: reset.offset, complete: false } : null,
      updates: []
    }
    const updates = reset
      ? reset.stamps
          .slice(reset.offset)
          .map((stamp) =>
            this.source.stampFor(this.sessionId, stamp.clientMessageId) === stamp
              ? stamp
              : { ...stamp, observedAt: null }
          )
      : this.diff()
    if (!reset && updates.length === 0) {
      this.changes = new Set()
      return undefined
    }
    return { frame, updates }
  }

  consume(frame: ProviderReceiptStreamUpdate): boolean {
    for (const update of frame.updates) {
      if (update.observedAt === null) {
        this.applied.delete(update.clientMessageId)
      } else {
        this.applied.set(update.clientMessageId, update)
      }
    }
    if (frame.reset && this.reset?.id === frame.reset.id) {
      this.reset.offset += frame.updates.length
      if (!frame.reset.complete) {
        return true
      }
      this.reset = undefined
    }
    return this.changes === null || this.changes.size > 0
  }

  handedOff(frame: ProviderReceiptStreamUpdate, complete: boolean): void {
    if (!frame.reset) {
      // Recompute a partial diff after consumption.
      this.changes = complete ? new Set() : null
    }
  }

  private diff(): ProviderReceiptUpdate[] {
    const updates: ProviderReceiptUpdate[] = []
    const ids =
      this.changes ??
      new Set([
        ...this.applied.keys(),
        ...Array.from(this.source.snapshot(this.sessionId), (stamp) => stamp.clientMessageId)
      ])
    // Send deletions first so a fully occupied view can make room for new keys.
    for (const id of ids) {
      const applied = this.applied.get(id)
      if (applied && !this.source.stampFor(this.sessionId, id)) {
        updates.push({ ...applied, observedAt: null })
      }
    }
    for (const id of ids) {
      const stamp = this.source.stampFor(this.sessionId, id)
      if (stamp && stamp !== this.applied.get(id)) {
        updates.push(stamp)
      }
    }
    return updates
  }
}
