import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type JournalPublication = {
  kind: 'commit' | 'reset' | 'operational' | 'detach' | 'end'
  source: object | null
  journal: AgentSessionJournal | null
  cursor?: AgentJournalCursor
  rows?: readonly JournalRow[]
}
type PublicationObserver = {
  next: (hint: JournalPublication) => void
  error: (error: unknown) => void
}

/** Bind commit delivery at adoption so writers cannot forget publication. Deliver in a microtask
 * to isolate durable writes from reader failures; ignore replaced/dropped handles. Activity clocks are memory-only. */
export class StructuredAgentSessionConversations extends Map<
  string,
  StructuredAgentSessionHostSession
> {
  private readonly observers = new Map<string, Set<{ observer: PublicationObserver }>>()
  private readonly attachments = new Map<
    string,
    { journal: AgentSessionJournal; release: () => void }
  >()
  private ended = false
  private readonly activity = new Map<string, number>()

  constructor(
    private readonly delivery: {
      observe?: (
        sessionId: string,
        journal: AgentSessionJournal,
        rows?: readonly JournalRow[]
      ) => void
      forget?: (sessionId: string) => void
      deliver: (sessionId: string, journal: AgentSessionJournal) => void
      /** Settle edges write no row and renew no activity clock. */
      deliverSettleEdge?: (sessionId: string, journal: AgentSessionJournal) => void
      logger: StructuredAgentSessionLogger
      /** Opening makes waiting state re-derive. */
      onOpened?: (sessionId: string) => void
      now: () => number
    }
  ) {
    super()
  }

  loadedSessionIds = (): string[] =>
    [...this].flatMap(([sessionId, { child }]) => (child ? [sessionId] : []))

  override set(sessionId: string, session: StructuredAgentSessionHostSession): this {
    const { journal } = session
    if (this.get(sessionId)?.journal === journal) {
      this.touch(sessionId)
      this.delivery.observe?.(sessionId, journal)
      this.delivery.onOpened?.(sessionId)
      return super.set(sessionId, session)
    }
    this.attachments.get(sessionId)?.release()
    let queued = false
    const source = {
      journal,
      release: () => {
        releaseCommit()
        releaseSettle()
      }
    }
    const current = () => this.attachments.get(sessionId) === source
    const releaseCommit = journal.observeCommits((rows) => {
      if (!current()) {
        return
      }
      this.publish(sessionId, rows === undefined ? 'reset' : 'commit', rows)
      try {
        this.delivery.observe?.(sessionId, journal, rows)
      } catch (error) {
        this.delivery.logger.warn('observing committed requests failed', {
          scope: 'request-outcomes',
          sessionId,
          error
        })
      }
      if (queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!current()) {
          return
        }
        try {
          this.delivery.deliver(sessionId, journal)
        } catch (error) {
          this.delivery.logger.warn('delivering a journal commit failed', {
            scope: 'journal-delivery',
            sessionId,
            error
          })
        }
      })
    })
    const releaseSettle = journal.stopMarks.observeSettleEdges(() => {
      if (!current()) {
        return
      }
      this.publish(sessionId, 'operational')
      queueMicrotask(() => {
        if (!current()) {
          return
        }
        try {
          this.delivery.deliverSettleEdge?.(sessionId, journal)
        } catch (error) {
          this.delivery.logger.warn("delivering a Stop's settle edge failed", {
            scope: 'stop-settle-delivery',
            sessionId,
            error
          })
        }
      })
    })
    this.attachments.set(sessionId, source)
    this.activity.set(sessionId, this.delivery.now())
    const adopted = super.set(sessionId, session)
    this.publish(sessionId, 'reset')
    this.delivery.observe?.(sessionId, journal)
    this.delivery.onOpened?.(sessionId)
    return adopted
  }

  observeConversationPublications(sessionId: string, observer: PublicationObserver): () => void {
    if (this.ended) {
      this.deliverHint(observer, { kind: 'end', source: null, journal: null }, () => {})
      return () => {}
    }
    let listeners = this.observers.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.observers.set(sessionId, listeners)
    }
    const registration = { observer }
    listeners.add(registration)
    const release = () => this.removeObserver(sessionId, registration)
    this.deliverHint(observer, this.hint(sessionId, 'reset'), release)
    return release
  }

  private hint(
    sessionId: string,
    kind: JournalPublication['kind'],
    rows?: readonly JournalRow[]
  ): JournalPublication {
    const source = kind === 'detach' || kind === 'end' ? undefined : this.attachments.get(sessionId)
    return {
      kind,
      source: source ?? null,
      journal: source?.journal ?? null,
      cursor: source?.journal.cursor(),
      rows
    }
  }

  publish(sessionId: string, kind: JournalPublication['kind'], rows?: readonly JournalRow[]): void {
    const observers = this.observers.get(sessionId)
    if (!observers?.size) {
      return
    }
    const hint = this.hint(sessionId, kind, rows)
    for (const registration of observers) {
      this.deliverHint(registration.observer, hint, () =>
        this.removeObserver(sessionId, registration)
      )
    }
  }

  private removeObserver(sessionId: string, registration: { observer: PublicationObserver }): void {
    const listeners = this.observers.get(sessionId)
    listeners?.delete(registration)
    if (listeners?.size === 0) {
      this.observers.delete(sessionId)
    }
  }

  private deliverHint(
    observer: PublicationObserver,
    hint: JournalPublication,
    release: () => void
  ): void {
    try {
      observer.next(hint)
    } catch (error) {
      release()
      try {
        observer.error(error)
      } catch {
        // A consumer cannot fail another consumer or the durable writer.
      }
    }
  }

  endPublications(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    for (const id of this.observers.keys()) {
      this.publish(id, 'end')
    }
    this.observers.clear()
  }

  override delete(sessionId: string): boolean {
    this.attachments.get(sessionId)?.release()
    this.attachments.delete(sessionId)
    this.delivery.forget?.(sessionId)
    this.activity.delete(sessionId)
    const removed = super.delete(sessionId)
    if (removed) {
      this.publish(sessionId, 'detach')
    }
    return removed
  }

  override clear(): void {
    for (const id of this.keys()) {
      this.delete(id)
    }
  }

  touch(sessionId: string): void {
    if (this.has(sessionId)) {
      this.activity.set(sessionId, this.delivery.now())
    }
  }

  lastActivityAt(sessionId: string): number | undefined {
    return this.activity.get(sessionId)
  }
}
