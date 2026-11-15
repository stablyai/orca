import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterCommit } from '../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { StructuredAgentSessionSettledTurnRoutes } from './structured-agent-session-settled-turn-routes'
import { StructuredAgentSessionSnapshotRoutes } from './structured-agent-session-snapshot-routes'

export type JournalPublication = {
  kind: 'commit' | 'reset' | 'operational' | 'detach' | 'end'
  source: object | null
  journal: AgentSessionJournal | null
  cursor?: AgentJournalCursor
  commit?: JournalWriterCommit
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
  private readonly settledTurns: StructuredAgentSessionSettledTurnRoutes
  private readonly snapshots: StructuredAgentSessionSnapshotRoutes

  constructor(
    private readonly delivery: {
      observe?: (
        sessionId: string,
        journal: AgentSessionJournal,
        commit?: JournalWriterCommit
      ) => void
      forget?: (sessionId: string) => void
      deliver: (sessionId: string, journal: AgentSessionJournal, inputChanged?: boolean) => void
      /** Settle edges write no row and renew no activity clock. */
      deliverSettleEdge?: (sessionId: string, journal: AgentSessionJournal) => void
      logger: StructuredAgentSessionLogger
      /** Opening makes waiting state re-derive. */
      onOpened?: (sessionId: string) => void
      workChanged?: (sessionId: string) => void
      now: () => number
    }
  ) {
    super()
    this.settledTurns = new StructuredAgentSessionSettledTurnRoutes(delivery.logger)
    this.snapshots = new StructuredAgentSessionSnapshotRoutes(delivery.logger)
  }

  loadedSessionIds = (): string[] =>
    [...this].flatMap(([sessionId, { child }]) => (child ? [sessionId] : []))

  override set(sessionId: string, session: StructuredAgentSessionHostSession): this {
    session.workChanged = () => this.delivery.workChanged?.(sessionId)
    const { journal } = session
    if (this.get(sessionId)?.journal === journal) {
      this.touch(sessionId)
      this.delivery.observe?.(sessionId, journal)
      this.delivery.onOpened?.(sessionId)
      super.set(sessionId, session)
      session.workChanged()
      return this
    }
    this.attachments.get(sessionId)?.release()
    let queued = false
    let inputChanged = false
    const source = {
      journal,
      release: () => {
        releaseCommit()
        releaseReplacing()
        releaseSettle()
      }
    }
    const current = () => this.attachments.get(sessionId) === source
    const releaseCommit = journal.observeCommits((commit) => {
      if (!current()) {
        return
      }
      this.publish(sessionId, 'commit', commit)
      session.workChanged?.()
      this.settledTurns.deliver(sessionId, journal, commit)
      try {
        this.delivery.observe?.(sessionId, journal, commit)
      } catch (error) {
        this.delivery.logger.warn('observing committed requests failed', {
          scope: 'request-outcomes',
          sessionId,
          error
        })
      }
      inputChanged ||= commit.inputChanged
      if (queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        const affectsInput = inputChanged
        inputChanged = false
        if (!current()) {
          return
        }
        try {
          this.delivery.deliver(sessionId, journal, affectsInput)
        } catch (error) {
          this.delivery.logger.warn('delivering a journal commit failed', {
            scope: 'journal-delivery',
            sessionId,
            error
          })
        }
      })
    })
    const releaseReplacing = journal.epochReplacements.observe((replaced) => {
      if (current()) {
        this.snapshots.replacing(sessionId, journal, replaced)
      }
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
    session.workChanged()
    this.publish(sessionId, 'reset')
    this.delivery.observe?.(sessionId, journal)
    this.delivery.onOpened?.(sessionId)
    return adopted
  }

  /** Terminal turn rows of each commit, delivered after COMMIT and before its publication callbacks. */
  observeSettledTurns: StructuredAgentSessionSettledTurnRoutes['observe'] = (...args) =>
    this.settledTurns.observe(...args)

  /** Saved Claude facts for one acquisition of this exact journal, kept current across replacements. */
  snapshotSource: StructuredAgentSessionSnapshotRoutes['observe'] = (...args) =>
    this.snapshots.observe(...args)

  observeConversationPublications = (
    sessionId: string,
    observer: PublicationObserver
  ): (() => void) => {
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
    this.deliverPublication(sessionId, registration, this.hint(sessionId, 'reset'))
    return release
  }

  private hint(
    sessionId: string,
    kind: JournalPublication['kind'],
    commit?: JournalWriterCommit
  ): JournalPublication {
    const source = kind === 'detach' || kind === 'end' ? undefined : this.attachments.get(sessionId)
    const hint: JournalPublication = {
      kind,
      source: source ?? null,
      journal: source?.journal ?? null,
      commit
    }
    return source ? { ...hint, cursor: commit?.cursor ?? source.journal.cursor() } : hint
  }

  publish(sessionId: string, kind: JournalPublication['kind'], commit?: JournalWriterCommit): void {
    if (kind === 'operational') {
      this.delivery.workChanged?.(sessionId)
    }
    const observers = this.observers.get(sessionId)
    if (!observers?.size) {
      return
    }
    const hint = this.hint(sessionId, kind, commit)
    for (const registration of observers) {
      this.deliverPublication(sessionId, registration, hint)
    }
  }

  private deliverPublication(
    sessionId: string,
    registration: { observer: PublicationObserver },
    hint: JournalPublication
  ): void {
    const release = () => this.removeObserver(sessionId, registration)
    this.deliverHint(registration.observer, hint, release)
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
    this.delivery.workChanged?.(sessionId)
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
