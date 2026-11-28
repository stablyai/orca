import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_DISPATCH_LIMITS } from '../../../../../shared/agent-session/journal/agent-session-dispatch-limits'
import type { JournalWriterCommit } from '../../../agent-session-journal/journal-writer-changes'
import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'

type Dispatch = {
  journal: SqlAgentSessionJournal
  clientMessageId: string
  cursor: AgentJournalCursor
  fence: number
  provider: 'claude' | 'codex'
  owns: () => boolean
}
type Attempt = Dispatch & {
  readers: Set<Subscriber>
  pending?: () => boolean
}

export class AgentSessionProviderReceipts {
  private readonly live = new Map<string, Set<Subscriber>>()
  private readonly emitted = new WeakMap<Subscriber, AgentJournalCursor>()
  private readonly attempts = new Map<string, Map<string, Attempt>>()
  private readonly waking = new Set<Attempt>()
  private wakeQueued = false

  constructor(private readonly schedule: (sub: Subscriber, send: () => void) => void) {}

  track(subscriber: Subscriber): void {
    const post = subscriber.emit
    subscriber.emit = (event) => this.emit(subscriber, post, event)
    subscriber.stopped?.addEventListener('abort', () => this.drop(subscriber), { once: true })
  }

  caughtUp(subscriber: Subscriber, journal: SqlAgentSessionJournal): void {
    const emitted = this.emitted.get(subscriber)
    if (subscriber.stopped?.aborted || !emitted || !sameJournalCursor(emitted, journal.cursor())) {
      return
    }
    const readers = this.live.get(subscriber.sessionId) ?? new Set<Subscriber>()
    readers.add(subscriber)
    this.live.set(subscriber.sessionId, readers)
  }

  private drop(subscriber: Subscriber): void {
    const { sessionId } = subscriber
    const readers = this.live.get(sessionId)
    if (readers?.delete(subscriber) && readers.size === 0) {
      this.live.delete(sessionId)
    }
    this.emitted.delete(subscriber)
    for (const attempt of this.attempts.get(sessionId)?.values() ?? []) {
      attempt.readers.delete(subscriber)
    }
  }

  bind(dispatch: Dispatch): ((isPending: () => boolean) => void) | undefined {
    const { journal, clientMessageId, cursor, fence } = dispatch
    const { sessionId } = journal.identity
    const live = this.live.get(sessionId)
    if (!live || journal.cursor().epoch !== cursor.epoch || !dispatch.owns()) {
      return undefined
    }
    const attempts = this.attempts.get(sessionId) ?? new Map<string, Attempt>()
    if (
      attempts.size >= AGENT_SESSION_DISPATCH_LIMITS[dispatch.provider] &&
      !attempts.has(clientMessageId)
    ) {
      return undefined
    }
    const readers = new Set(
      [...live].filter(
        (reader) => this.emitted.get(reader)?.epoch === cursor.epoch && reader.fence === fence
      )
    )
    if (!readers.size) {
      return undefined
    }
    const attempt: Attempt = { ...dispatch, readers }
    attempts.set(clientMessageId, attempt)
    this.attempts.set(sessionId, attempts)
    return (isPending) => {
      if (attempt.pending || attempts.get(clientMessageId) !== attempt) {
        return
      }
      attempt.pending = isPending
      this.waking.add(attempt)
      if (!this.wakeQueued) {
        this.wakeQueued = true
        queueMicrotask(this.wake)
      }
    }
  }

  private wake = (): void => {
    this.wakeQueued = false
    const readers = new Set<Subscriber>()
    for (const attempt of this.waking) {
      if (this.isPending(attempt)) {
        attempt.readers.forEach((reader) => readers.add(reader))
      }
    }
    this.waking.clear()
    for (const reader of readers) {
      this.schedule(reader, () => {
        try {
          const cursor = this.emitted.get(reader)
          const providerReceived = cursor && this.take(reader, cursor, reader.fence)
          if (cursor && providerReceived) {
            reader.emit({
              type: 'batch',
              sessionId: reader.sessionId,
              fence: reader.fence,
              batch: emptyAgentSessionBatch(cursor),
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
    return (
      this.attempts.get(attempt.journal.identity.sessionId)?.get(attempt.clientMessageId) ===
        attempt &&
      attempt.owns() &&
      attempt.pending?.() === true
    )
  }

  observe(sessionId: string, journal: SqlAgentSessionJournal, commit: JournalWriterCommit): void {
    const attempts = this.attempts.get(sessionId)
    if (!attempts) {
      return
    }
    for (const [id, attempt] of attempts) {
      if (
        attempt.journal !== journal ||
        attempt.cursor.epoch !== commit.cursor.epoch ||
        !attempt.owns()
      ) {
        attempts.delete(id)
      }
    }
    for (const change of commit.publication?.promptDispatches ?? []) {
      if (
        attempts.get(change.clientMessageId)?.cursor.sequence === change.previousHandoverSequence
      ) {
        attempts.delete(change.clientMessageId)
      }
    }
    if (!attempts.size) {
      this.attempts.delete(sessionId)
    }
  }

  forget(sessionId: string): void {
    this.attempts.delete(sessionId)
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
    const providerReceived =
      event.type === 'batch' && !event.providerReceived
        ? this.take(subscriber, event.batch.cursor, event.fence)
        : undefined
    post(providerReceived && event.type === 'batch' ? { ...event, providerReceived } : event)
    if (event.type === 'batch') {
      this.emitted.set(subscriber, event.batch.cursor)
    } else if (event.type !== 'end') {
      this.emitted.set(subscriber, event.page.liveCursor ?? event.page.window.nextCursor)
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
    for (const attempt of this.attempts.get(subscriber.sessionId)?.values() ?? []) {
      if (
        attempt.readers.has(subscriber) &&
        attempt.fence === fence &&
        attempt.cursor.epoch === cursor.epoch &&
        attempt.cursor.sequence <= cursor.sequence &&
        this.isPending(attempt)
      ) {
        attempt.readers.delete(subscriber)
        providerReceived ??= []
        providerReceived.push(attempt.cursor.sequence)
      }
    }
    return providerReceived
  }
}
