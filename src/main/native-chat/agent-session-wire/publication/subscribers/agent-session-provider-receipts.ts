import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_DISPATCH_LIMITS } from '../../../../../shared/agent-session/journal/agent-session-dispatch-limits'
import type { JournalWriterCommit } from '../../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import {
  withProviderReceipt,
  type ProviderReceiptConfirmation
} from '../../journal-ingress/provider-receipt-publication'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { Subscriber } from './agent-session-subscribe-input'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import type { ProviderReceiptDispatch } from './agent-session-provider-receipt-attempt'

type Batch = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type Reader = {
  subscriber: Subscriber
  journal: SqlAgentSessionJournal
  opened?: AgentJournalCursor
  fence?: number
  emitted?: AgentJournalCursor
  post: Subscriber['emit']
  owed: Map<number, Attempt>
  lowest: number
}
type Attempt = ProviderReceiptDispatch & {
  itemId: string
  recipients: Set<Reader>
  pending?: () => boolean
  retired?: true
}

export class AgentSessionProviderReceipts {
  private readonly live = new WeakMap<SqlAgentSessionJournal, Set<Reader>>()
  private readonly readers = new WeakMap<Subscriber, Reader>()
  private readonly attempts = new WeakMap<SqlAgentSessionJournal, Map<string, Attempt>>()
  private readonly waking = new Map<SqlAgentSessionJournal, Set<Attempt>>()
  private wakeQueued = false

  constructor(private readonly schedule: (sub: Subscriber) => void) {}

  track(subscriber: Subscriber, journal: SqlAgentSessionJournal): void {
    const reader: Reader = {
      subscriber,
      journal,
      post: subscriber.emit,
      owed: new Map(),
      lowest: Infinity
    }
    this.readers.set(subscriber, reader)
    subscriber.providerReceiptsRouting = (event) =>
      event.type === 'batch' && !!reader.opened && !!this.waking.get(reader.journal)?.size
    subscriber.emit = (event) => {
      const outgoing = withProviderReceipt(() => this.decorate(reader, event)) ?? event
      reader.post(outgoing)
      if (event.type === 'batch') {
        reader.emitted = event.batch.cursor
      }
    }
    subscriber.stopped?.addEventListener('abort', () => this.drop(reader), { once: true })
  }

  hasLiveReader(journal: SqlAgentSessionJournal): boolean {
    return !!this.live.get(journal)?.size
  }

  caughtUp(subscriber: Subscriber, journal: SqlAgentSessionJournal): void {
    const reader = this.readers.get(subscriber)
    if (!reader || subscriber.stopped?.aborted || subscriber.owedSnapshotFence !== undefined) {
      return
    }
    if (reader.journal !== journal) {
      this.drop(reader)
      reader.journal = journal
    }
    if (reader.opened) {
      return
    }
    // The adopted journal cursor orders opening against handovers, even if this lane trails it.
    reader.opened = journal.cursor()
    reader.fence = subscriber.fence
    const live = this.live.get(journal) ?? new Set()
    live.add(reader)
    this.live.set(journal, live)
  }

  private drop(reader: Reader): void {
    reader.opened = reader.emitted = undefined
    const live = this.live.get(reader.journal)
    if (!live?.delete(reader)) {
      return
    }
    for (const attempt of reader.owed.values()) {
      this.release(reader, attempt)
    }
    if (!live.size) {
      for (const attempt of this.attempts.get(reader.journal)?.values() ?? []) {
        this.retire(attempt)
      }
    }
  }

  bind(dispatch: ProviderReceiptDispatch): ProviderReceiptConfirmation | undefined {
    const { journal, cursor, clientMessageId, provider } = dispatch
    if (
      !this.hasLiveReader(journal) ||
      journal.cursor().epoch !== cursor.epoch ||
      !dispatch.owns()
    ) {
      return undefined
    }
    const attempts = this.attempts.get(journal) ?? new Map<string, Attempt>()
    const previous = attempts.get(clientMessageId)
    if (
      previous?.cursor.sequence === cursor.sequence ||
      (!previous && attempts.size >= AGENT_SESSION_DISPATCH_LIMITS[provider])
    ) {
      return undefined
    }
    if (previous) {
      this.retire(previous)
    }
    const attempt: Attempt = {
      ...dispatch,
      itemId: agentJournalSubmissionKey(clientMessageId),
      recipients: new Set()
    }
    attempts.set(clientMessageId, attempt)
    this.attempts.set(journal, attempts)
    if (attempts.size === 1) {
      journal.trackProviderReceiptSettlements(true)
    }
    return Object.assign(
      (isPending: () => boolean) => {
        if (!attempt.retired && !attempt.pending) {
          attempt.pending = isPending
          const changed = this.waking.get(journal) ?? new Set<Attempt>()
          changed.add(attempt)
          this.waking.set(journal, changed)
          if (!this.wakeQueued) {
            this.wakeQueued = true
            queueMicrotask(this.wake)
          }
        }
      },
      { cancel: () => withProviderReceipt(() => this.retire(attempt)) }
    )
  }

  private wake = (): void => {
    const ready = new Set<Reader>()
    this.wakeQueued = false
    for (const [journal, changed] of this.waking) {
      this.waking.delete(journal)
      for (const attempt of changed) {
        withProviderReceipt(() => {
          if (!this.isPending(attempt)) {
            this.retire(attempt)
            return
          }
          for (const reader of this.live.get(journal) ?? []) {
            const { opened, fence, emitted } = reader
            if (
              opened?.epoch === attempt.cursor.epoch &&
              opened.sequence < attempt.cursor.sequence &&
              fence === attempt.fence
            ) {
              attempt.recipients.add(reader)
              reader.owed.set(attempt.cursor.sequence, attempt)
              reader.lowest = Math.min(reader.lowest, attempt.cursor.sequence)
              if (emitted && emitted.sequence >= attempt.cursor.sequence) {
                ready.add(reader)
              }
            }
          }
        })
      }
    }
    for (const reader of ready) {
      withProviderReceipt(() => this.schedule(reader.subscriber))
    }
  }

  private isPending(attempt: Attempt): boolean {
    return !attempt.retired && attempt.owns() && attempt.pending?.() === true
  }

  private release(reader: Reader, attempt: Attempt): void {
    attempt.recipients.delete(reader)
    reader.owed.delete(attempt.cursor.sequence)
    if (reader.lowest === attempt.cursor.sequence) {
      reader.lowest = Math.min(...reader.owed.keys())
    }
  }

  private retire(attempt: Attempt): void {
    if (attempt.retired) {
      return
    }
    attempt.retired = true
    this.waking.get(attempt.journal)?.delete(attempt)
    for (const reader of attempt.recipients) {
      this.release(reader, attempt)
    }
    const attempts = this.attempts.get(attempt.journal)!
    attempts.delete(attempt.clientMessageId)
    if (!attempts.size) {
      attempt.journal.trackProviderReceiptSettlements(false)
    }
  }

  observe(journal: SqlAgentSessionJournal, commit: JournalWriterCommit): void {
    const attempts = this.attempts.get(journal)
    for (const change of commit.publication?.promptDispatches ?? []) {
      const attempt = attempts?.get(change.clientMessageId)
      if (
        attempt &&
        change.previousHandoverSequence !== undefined &&
        change.previousHandoverSequence >= attempt.cursor.sequence
      ) {
        this.retire(attempt)
      }
    }
  }

  private decorate(reader: Reader, event: AgentSessionSubscribeEvent): Batch | undefined {
    if (
      event.type === 'snapshot' ||
      event.type === 'reset' ||
      ('fence' in event &&
        reader.opened &&
        event.fence !== undefined &&
        event.fence !== reader.fence)
    ) {
      this.drop(reader)
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
      reader.emitted = event.page.liveCursor ?? event.page.window.nextCursor
    }
    if (event.type === 'batch') {
      const providerReceived = this.take(reader, event.batch.cursor, event.fence, event.batch)
      if (providerReceived) {
        return { ...event, providerReceived }
      }
    }
    return undefined
  }

  sendStandalone(subscriber: Subscriber): void {
    withProviderReceipt(() => {
      const reader = this.readers.get(subscriber)
      const cursor = reader?.emitted
      if (!reader || !cursor || subscriber.stopped?.aborted) {
        return
      }
      const providerReceived = this.take(reader, cursor, subscriber.fence)
      if (providerReceived) {
        reader.post({
          type: 'batch',
          sessionId: subscriber.sessionId,
          fence: subscriber.fence,
          batch: emptyAgentSessionBatch(cursor),
          providerReceived
        })
      }
    })
  }

  private take(
    reader: Reader,
    cursor: AgentJournalCursor,
    fence: number | undefined,
    batch?: Batch['batch']
  ): number[] | undefined {
    if (
      cursor.sequence < reader.lowest ||
      reader.opened?.epoch !== cursor.epoch ||
      reader.fence !== fence
    ) {
      return undefined
    }
    let stamps: number[] | undefined
    for (const attempt of reader.owed.values()) {
      const { sequence } = attempt.cursor
      if (sequence > cursor.sequence) {
        continue
      }
      this.release(reader, attempt)
      if (!this.isPending(attempt)) {
        continue
      }
      if (
        batch &&
        (reader.emitted?.sequence ?? 0) < sequence &&
        (!batch.items.some(
          (item) => item.sequence === sequence && item.itemId === attempt.itemId
        ) ||
          !batch.submissions.some(
            (submission) =>
              submission.clientMessageId === attempt.clientMessageId &&
              submission.dispatchState === 'pending' &&
              submission.handedOverAt !== undefined
          ))
      ) {
        continue
      }
      stamps ??= []
      stamps.push(sequence)
    }
    return stamps
  }
}
