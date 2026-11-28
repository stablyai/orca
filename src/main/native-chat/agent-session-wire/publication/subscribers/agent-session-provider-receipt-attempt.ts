import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'

export type ProviderReceiptDispatch = {
  journal: SqlAgentSessionJournal
  clientMessageId: string
  cursor: AgentJournalCursor
  fence: number
  provider: 'claude' | 'codex'
  owns: () => boolean
  readFence?: () => number | undefined
}
export type ReceiptLink = { attempt?: Attempt }
export type Attempt = ProviderReceiptDispatch & {
  readers: Set<Subscriber>
  link: ReceiptLink
  pending?: () => boolean
}
export type SessionAttempts = {
  journal: SqlAgentSessionJournal
  epoch: string
  fence: number
  bySequence: Map<number, Attempt | string>
  changed: Set<Attempt>
  readFence?: ProviderReceiptDispatch['readFence']
}

export type EmittedReceiptCursor = { cursor: AgentJournalCursor; fence: number }

type LiveReader = { journal: SqlAgentSessionJournal; opened: AgentJournalCursor }

export class ProviderReceiptReaders {
  private readonly live = new Map<string, Map<Subscriber, LiveReader>>()
  private readonly counts = new WeakMap<SqlAgentSessionJournal, Map<string, number>>()
  readonly emitted = new WeakMap<Subscriber, EmittedReceiptCursor>()

  atHead(journal: SqlAgentSessionJournal, fence: number): boolean {
    return (this.counts.get(journal)?.get(positionKey(journal.cursor(), fence)) ?? 0) > 0
  }

  caughtUp(reader: Subscriber, journal: SqlAgentSessionJournal): void {
    const position = this.emitted.get(reader)
    if (
      reader.stopped?.aborted ||
      !position ||
      position.fence !== reader.fence ||
      !sameJournalCursor(position.cursor, journal.cursor())
    ) {
      return
    }
    const readers = this.live.get(reader.sessionId) ?? new Map<Subscriber, LiveReader>()
    if (!readers.has(reader)) {
      readers.set(reader, { journal, opened: position.cursor })
      this.live.set(reader.sessionId, readers)
      this.count(journal, position, 1)
    }
  }

  boundTo({ journal, cursor, fence }: ProviderReceiptDispatch): Set<Subscriber> {
    const bound = new Set<Subscriber>()
    for (const [reader, { journal: source, opened }] of this.live.get(journal.identity.sessionId) ??
      []) {
      const position = this.emitted.get(reader)
      if (
        source === journal &&
        opened.epoch === cursor.epoch &&
        opened.sequence < cursor.sequence &&
        position?.cursor.epoch === cursor.epoch &&
        position.cursor.sequence >= cursor.sequence - 1 &&
        position.fence === fence &&
        reader.fence === fence
      ) {
        bound.add(reader)
      }
    }
    return bound
  }

  isLive(reader: Subscriber): boolean {
    return this.live.get(reader.sessionId)?.has(reader) === true
  }

  drop(reader: Subscriber): boolean {
    const readers = this.live.get(reader.sessionId)
    const live = readers?.get(reader)
    const position = this.emitted.get(reader)
    this.emitted.delete(reader)
    if (!readers || !live || !position) {
      return false
    }
    this.count(live.journal, position, -1)
    readers.delete(reader)
    if (!readers.size) {
      this.live.delete(reader.sessionId)
      return true
    }
    return false
  }

  posted(reader: Subscriber, position: EmittedReceiptCursor): void {
    const previous = this.emitted.get(reader)
    if (
      previous &&
      previous.fence === position.fence &&
      sameJournalCursor(previous.cursor, position.cursor)
    ) {
      return
    }
    const live = this.live.get(reader.sessionId)?.get(reader)
    if (live && previous) {
      this.count(live.journal, previous, -1)
      this.count(live.journal, position, 1)
    }
    this.emitted.set(reader, position)
  }

  private count(
    journal: SqlAgentSessionJournal,
    { cursor, fence }: EmittedReceiptCursor,
    delta: number
  ): void {
    const counts = this.counts.get(journal) ?? new Map<string, number>()
    const key = positionKey(cursor, fence)
    const next = (counts.get(key) ?? 0) + delta
    if (next) {
      counts.set(key, next)
      this.counts.set(journal, counts)
    } else {
      counts.delete(key)
      if (!counts.size) {
        this.counts.delete(journal)
      }
    }
  }
}

function positionKey({ epoch, sequence }: AgentJournalCursor, fence: number): string {
  return `${epoch}:${sequence}:${fence}`
}

export function receiptCursorOf(
  event: AgentSessionSubscribeEvent,
  fence: number
): EmittedReceiptCursor | undefined {
  if (event.type === 'batch') {
    return { cursor: event.batch.cursor, fence: event.fence ?? fence }
  }
  if (event.type !== 'end') {
    return { cursor: event.page.liveCursor ?? event.page.window.nextCursor, fence: event.fence }
  }
  return undefined
}
