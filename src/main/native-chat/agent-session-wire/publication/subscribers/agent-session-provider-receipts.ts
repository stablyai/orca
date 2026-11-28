import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_DISPATCH_LIMITS } from '../../../../../shared/agent-session/journal/agent-session-dispatch-limits'
import type { JournalWriterCommit } from '../../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { ProviderReceiptConfirmation } from '../../journal-ingress/provider-receipt-publication'
import type { Subscriber } from './agent-session-subscribe-input'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'

import {
  ProviderReceiptReaders,
  receiptCursorOf,
  type Attempt,
  type ProviderReceiptDispatch,
  type ReceiptLink,
  type SessionAttempts
} from './agent-session-provider-receipt-attempt'

export class AgentSessionProviderReceipts {
  private readonly readers = new ProviderReceiptReaders()
  private readonly attempts = new Map<string, SessionAttempts>()
  private readonly bound = new WeakMap<Subscriber, Set<Attempt>>()
  private readonly owed = new WeakMap<Subscriber, Set<Attempt>>()
  private readonly waking = new Set<SessionAttempts>()
  private wakeQueued = false

  constructor(private readonly schedule: (sub: Subscriber, send: () => void) => void) {}

  track(subscriber: Subscriber): void {
    const post = subscriber.emit
    subscriber.emit = (event) => this.emit(subscriber, post, event)
    subscriber.stopped?.addEventListener('abort', () => this.drop(subscriber), { once: true })
  }

  hasReaderAtHead(journal: SqlAgentSessionJournal, fence: number): boolean {
    return this.readers.atHead(journal, fence)
  }

  caughtUp(subscriber: Subscriber, journal: SqlAgentSessionJournal): void {
    this.readers.caughtUp(subscriber, journal)
  }

  private drop(subscriber: Subscriber): void {
    const last = this.readers.drop(subscriber)
    for (const attempt of this.bound.get(subscriber) ?? []) {
      this.release(attempt, subscriber)
    }
    if (last) {
      this.forget(subscriber.sessionId)
    }
  }

  private release(attempt: Attempt, reader: Subscriber): void {
    this.bound.get(reader)?.delete(attempt)
    this.owed.get(reader)?.delete(attempt)
    attempt.readers.delete(reader)
    if (!attempt.readers.size) {
      const session = this.attempts.get(attempt.journal.identity.sessionId)
      if (session?.bySequence.get(attempt.cursor.sequence) === attempt) {
        session.bySequence.set(attempt.cursor.sequence, attempt.clientMessageId)
        session.changed.delete(attempt)
      }
      attempt.link.attempt = undefined
      attempt.pending = undefined
    }
  }

  bind(dispatch: ProviderReceiptDispatch): ProviderReceiptConfirmation | undefined {
    const { journal, cursor, fence } = dispatch
    const { sessionId } = journal.identity
    if (journal.cursor().epoch !== cursor.epoch || !dispatch.owns()) {
      return undefined
    }
    let session = this.attempts.get(sessionId)
    if (
      session &&
      (session.journal !== journal || session.epoch !== cursor.epoch || session.fence !== fence)
    ) {
      this.forget(sessionId)
      session = undefined
    }
    if (
      session?.bySequence.has(cursor.sequence) ||
      (session && session.bySequence.size >= AGENT_SESSION_DISPATCH_LIMITS[dispatch.provider])
    ) {
      return undefined
    }
    const readers = this.readers.boundTo(dispatch)
    if (!readers.size) {
      return undefined
    }
    session ??= {
      journal,
      epoch: cursor.epoch,
      fence,
      bySequence: new Map(),
      changed: new Set(),
      readFence: dispatch.readFence
    }
    const link: ReceiptLink = {}
    const attempt: Attempt = { ...dispatch, readers, link }
    link.attempt = attempt
    session.bySequence.set(cursor.sequence, attempt)
    this.attempts.set(sessionId, session)
    if (session.bySequence.size === 1) {
      journal.trackProviderReceiptSettlements(true)
    }
    for (const reader of readers) {
      const attempts = this.bound.get(reader) ?? new Set<Attempt>()
      attempts.add(attempt)
      this.bound.set(reader, attempts)
    }
    return this.confirmation(link)
  }

  private confirmation(link: ReceiptLink): ProviderReceiptConfirmation {
    const confirm = (isPending: () => boolean): void => {
      const attempt = link.attempt
      if (attempt && !attempt.pending) {
        attempt.pending = isPending
        this.queueWake(attempt)
      }
    }
    return Object.assign(confirm, {
      cancel: () => {
        const attempt = link.attempt
        if (attempt) {
          link.attempt = undefined
          this.queueWake(attempt)
        }
      }
    })
  }

  private queueWake(attempt: Attempt): void {
    const session = this.attempts.get(attempt.journal.identity.sessionId)
    if (!session) {
      return
    }
    session.changed.add(attempt)
    this.waking.add(session)
    if (!this.wakeQueued) {
      this.wakeQueued = true
      queueMicrotask(this.wake)
    }
  }

  private wake = (): void => {
    this.wakeQueued = false
    for (const session of this.waking) {
      this.fanOut(session)
    }
  }

  private fanOut(session: SessionAttempts): void {
    this.waking.delete(session)
    const readers = new Set<Subscriber>()
    for (const attempt of session.changed) {
      if (!this.isPending(attempt)) {
        for (const reader of attempt.readers) {
          this.release(attempt, reader)
        }
        continue
      }
      for (const reader of attempt.readers) {
        const owed = this.owed.get(reader) ?? new Set<Attempt>()
        owed.add(attempt)
        this.owed.set(reader, owed)
        readers.add(reader)
      }
    }
    session.changed.clear()
    for (const reader of readers) {
      this.schedule(reader, () => {
        try {
          const emitted = this.readers.emitted.get(reader)
          const providerReceived = emitted && this.take(reader, emitted.cursor, emitted.fence)
          if (emitted && providerReceived) {
            reader.emit({
              type: 'batch',
              sessionId: reader.sessionId,
              fence: emitted.fence,
              batch: emptyAgentSessionBatch(emitted.cursor),
              providerReceived
            })
          }
        } catch {
          // Losing a receipt must leave transcript delivery running.
        }
      })
    }
  }

  private isPending(attempt: Attempt): boolean {
    return attempt.link.attempt === attempt && attempt.owns() && attempt.pending?.() === true
  }

  private remove(session: SessionAttempts, sequence: number): void {
    const attempt = session.bySequence.get(sequence)
    session.bySequence.delete(sequence)
    if (attempt && typeof attempt !== 'string') {
      session.changed.delete(attempt)
      for (const reader of attempt.readers) {
        this.release(attempt, reader)
      }
    }
  }

  observe(sessionId: string, journal: SqlAgentSessionJournal, commit: JournalWriterCommit): void {
    const session = this.attempts.get(sessionId)
    if (!session) {
      return
    }
    if (
      session.journal !== journal ||
      session.epoch !== commit.cursor.epoch ||
      (session.readFence && session.fence !== session.readFence())
    ) {
      this.forget(sessionId)
      return
    }
    for (const change of commit.publication?.promptDispatches ?? []) {
      const sequence = change.previousHandoverSequence
      if (sequence === undefined) {
        continue
      }
      const attempt = session.bySequence.get(sequence)
      if (
        attempt &&
        (typeof attempt === 'string' ? attempt : attempt.clientMessageId) === change.clientMessageId
      ) {
        this.remove(session, sequence)
      }
    }
    if (!session.bySequence.size) {
      this.forget(sessionId)
    }
  }

  forget(sessionId: string): void {
    const session = this.attempts.get(sessionId)
    if (session) {
      this.waking.delete(session)
      for (const sequence of session.bySequence.keys()) {
        this.remove(session, sequence)
      }
      this.attempts.delete(sessionId)
      session.journal.trackProviderReceiptSettlements(false)
    }
  }

  /** Called after projection, at the same post guard as ordinary frames. */
  private emit(
    subscriber: Subscriber,
    post: Subscriber['emit'],
    event: AgentSessionSubscribeEvent
  ): void {
    if (event.type === 'snapshot' || event.type === 'reset') {
      this.drop(subscriber)
    }
    let providerReceived: number[] | undefined
    if (event.type === 'batch' && !event.providerReceived && this.readers.isLive(subscriber)) {
      const session = this.attempts.get(subscriber.sessionId)
      if (session?.changed.size) {
        this.fanOut(session)
      }
      providerReceived = this.take(subscriber, event.batch.cursor, event.fence)
    }
    post(providerReceived && event.type === 'batch' ? { ...event, providerReceived } : event)
    const position = receiptCursorOf(event, subscriber.fence)
    if (position) {
      this.readers.posted(subscriber, position)
    }
  }

  private take(
    subscriber: Subscriber,
    cursor: AgentJournalCursor,
    fence: number | undefined
  ): number[] | undefined {
    if (subscriber.stopped?.aborted || fence !== subscriber.fence) {
      return undefined
    }
    let providerReceived: number[] | undefined
    for (const attempt of this.owed.get(subscriber) ?? []) {
      if (!this.isPending(attempt)) {
        this.release(attempt, subscriber)
        continue
      }
      if (
        attempt.fence === fence &&
        attempt.cursor.epoch === cursor.epoch &&
        attempt.cursor.sequence <= cursor.sequence
      ) {
        this.release(attempt, subscriber)
        providerReceived ??= []
        providerReceived.push(attempt.cursor.sequence)
      }
    }
    return providerReceived
  }
}
