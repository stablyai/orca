import type { StructuredAgentSessionStatusObserverOptions } from './structured-agent-session-status-observation'
// The host's answer to "what is every structured session doing", fanned out to session lists.
//
// A client used to learn whether a turn was running by replaying the journal through its own
// reducer, which tied the answer to whichever surface happened to hold a reader open: hide the
// chat and the sidebar froze on the last thing it had heard. The host always has the journal, so
// it projects the status once per journal publication and sends only the changes.
//
// The last projection is kept after the session's provider child is evicted: an idle session is
// still idle without a process, and a renderer that reloads must not lose every settled row until
// each chat is reopened. Restart is the one boundary that forgets, and restoring readable sessions
// republishes them.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionStatusSummary } from './structured-agent-session-status-summary'
import { structuredStatusChildWork } from './structured-agent-session-status-child-work'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  StructuredAgentSessionStatusOwnership,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

type StatusFeedSession = {
  journal: AgentSessionJournal
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  child?: Pick<StructuredAgentSessionProviderChild, 'phase' | 'generation' | 'fence'> | null
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  now: () => number
  /** Where a failing sink or observer is reported; neither may cost subscribers their event. */
  logger: StructuredAgentSessionLogger
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ) => void
  /** Resolved on every call: the host builds this feed in a field initializer, before its own
   *  deps are assigned. The sink holds the session's child records; the summary reads them there. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** The session's child records changed, so every other reader of them republishes. */
  onChildWorkChanged?: (sessionId: string) => void
  /** The session's agent proved a start: its row's phase became `ready`. */
  onAgentStarted?: (sessionId: string) => void
}

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusOwnership(() =>
    this.deps.statusSink?.()
  )
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  // Never evicted: chats are named only while in here, and AI Vault reads closed ones' names here.
  private readonly published = new Map<
    string,
    {
      summary: AgentSessionStatusSummary
      firstInputSubmissionKey: string | null
    }
  >()
  /** The user's newest accepted send each session was last projected with; a new one retires
   *  settled children. */
  private readonly acceptedSends = new Map<string, string>()
  private readonly projections = new StructuredAgentSessionJournalProjections()

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {}

  private logFailure(scope: string, message: string, sessionId: string, error: unknown): void {
    this.deps.logger.warn(message, { scope, sessionId, error })
  }

  /** Opens with every session this host has projected, live ones re-read, then only changes. */
  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Re-project before registering: a change found here has to reach the subscribers that
    // already read the old value, and the arriving one carries it in its snapshot instead.
    for (const [sessionId] of this.deps.sessions) {
      this.publish(sessionId, undefined, { replay: true })
    }
    this.subscribers.set(subscriber.id, subscriber)
    this.emit(subscriber, {
      type: 'snapshot',
      sessions: [...this.published.values()].map(({ summary }) => summary)
    })
    return () => this.unsubscribe(subscriber.id)
  }

  /** The host stopped holding the session: ownership leaves the retained projection, and the
   *  row, with every child record under it, leaves the sink. `published` keeps the projection for
   *  reload history. */
  close(sessionId: string): void {
    this.revokeLive(sessionId)
    this.forget(sessionId)
  }

  /** The sink lists what is running; a forgotten session must not be in it. Its child records
   *  leave the store with its row, and the retained projection re-reads them like any summary. */
  forget(sessionId: string): void {
    this.acceptedSends.delete(sessionId)
    try {
      this.ownership.forget(sessionId)
    } catch (error) {
      this.logFailure('status-sink-forget', 'status sink forget failed', sessionId, error)
    }
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    if (!previous || (!previous.children && !previous.backgroundTasks)) {
      return
    }
    const { children: _children, backgroundTasks: _backgroundTasks, ...rest } = previous
    const retained = { ...rest, ...this.childWorkFields(sessionId, previous.agent) }
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.broadcast({ type: 'status', session: retained })
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  /** Revoke live execution authority while retaining the last projection for reload history. A
   *  Stop still ending work is live state too: with the host gone, nothing here is ending it. */
  revokeLive(sessionId: string): void {
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    if (!previous) {
      return
    }
    const {
      hostExecutionOwned: _hostExecutionOwned,
      hostExecutionPhase: _hostExecutionPhase,
      stopping: _stopping,
      ...retained
    } = previous
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.sink(retained)
    this.broadcast({
      type: 'status',
      session: retained
    })
  }

  /** The record's name changed outside the journal. A closed chat's retained row follows it too,
   *  so every list still showing that conversation learns the name without a tab. */
  publishConversationName(sessionId: string): void {
    if (this.deps.sessions.has(sessionId)) {
      this.publish(sessionId)
      return
    }
    const publication = this.published.get(sessionId)
    const name = this.deps.getRecord(sessionId)?.conversationName
    if (!publication || publication.summary.conversationName === name) {
      return
    }
    const { conversationName: _previous, ...rest } = publication.summary
    const summary = name ? { ...rest, conversationName: name } : rest
    this.published.set(sessionId, { ...publication, summary })
    this.broadcast({ type: 'status', session: summary })
  }

  /** The summary last published for the session, as every status subscriber last saw it. */
  readPublished = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.published.get(sessionId)?.summary

  /** The projection behind the session's row, cached per commit: the latest request it read, so
   *  the completion feed follows it without snapshotting the journal again, and its `stopping`,
   *  which the steer hold reads instead of deriving it again. */
  journalProjection(
    sessionId: string,
    journal?: AgentSessionJournal
  ): StructuredAgentSessionJournalProjection | null {
    const source = journal ?? this.deps.sessions.get(sessionId)?.journal
    return source ? this.projections.read(source, this.deps.getRecord(sessionId)) : null
  }

  /** Re-projects one session after its journal changed; equal projections are not re-sent. */
  publish(sessionId: string, journal?: AgentSessionJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const source = journal ?? session.journal
    const record = this.deps.getRecord(sessionId)
    const projection = this.projections.read(source, record)
    this.retireSettledChildrenOnNewTurn(sessionId, session, projection.acceptedSendKey)
    const summary = structuredAgentSessionStatusSummary({
      sessionId,
      session,
      journal: source,
      record,
      state: projection.state,
      stopping: projection.stopping,
      childWork: this.childWorkFields(sessionId, session.params.provider),
      now: this.deps.now
    })
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    const summaryChanged = !previous || !structuredStatusSummariesEqual(previous, summary)
    const inputChanged = publication?.firstInputSubmissionKey !== projection.firstInputSubmissionKey
    if (!summaryChanged && !inputChanged) {
      if (!this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, session.params.location)
      }
      return
    }
    this.published.set(sessionId, {
      summary,
      firstInputSubmissionKey: projection.firstInputSubmissionKey
    })
    if (summaryChanged) {
      this.sink(summary, session.params.location)
      this.broadcast({ type: 'status', session: summary })
    }
    if (summary.hostExecutionPhase === 'ready' && previous?.hostExecutionPhase !== 'ready') {
      this.deps.onAgentStarted?.(sessionId)
    }
    try {
      this.deps.onStatusChanged?.(summary, {
        replay: options?.replay === true,
        firstInputSubmissionKey: projection.firstInputSubmissionKey
      })
    } catch (error) {
      // An observer must never cost the subscribers their status event.
      this.logFailure('status-observer', 'status observer failed', sessionId, error)
    }
  }

  /** A finished child's record stays, with its outcome, until the user's next turn: the next send
   *  the provider accepts (see `newestAcceptedSendKey`), unless it still owns live work. No surface
   *  lists it (they list running children only); it stays so a late frame of its run cannot bring
   *  it back as live, so an acknowledged Stop's provisional ending can be replaced by the task's
   *  own, and so its live work keeps its owner. The provider ending the session removes nothing:
   *  children still live settle `unknown`. The one earlier death is the host letting go of the
   *  session, whose row takes every child record with it (see `forget`). A command never settles:
   *  its record goes when it stops. */
  private retireSettledChildrenOnNewTurn(
    sessionId: string,
    session: StatusFeedSession,
    acceptedSendKey: string
  ): void {
    const seen = this.acceptedSends.has(sessionId)
    const previous = this.acceptedSends.get(sessionId)
    this.acceptedSends.set(sessionId, acceptedSendKey)
    if (!seen || acceptedSendKey === previous) {
      return
    }
    this.admitChildWork(sessionId, session, [{ type: 'turn-started', observedAt: this.deps.now() }])
  }

  /** The summary's child fields, from the records the store holds for the session. Usage is
   *  dropped on purpose: a `task_progress` tick would otherwise fail the equality check and
   *  re-broadcast a full summary to every remote subscriber for a number no session list renders.
   *  Tokens stay live on the background-task channel. */
  private childWorkFields(
    sessionId: string,
    provider: StatusFeedSession['params']['provider']
  ): Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'> {
    const { children, backgroundTasks } = structuredStatusChildWork(
      this.readChildWork(sessionId),
      provider
    )
    return {
      ...(backgroundTasks && backgroundTasks.length > 0
        ? { backgroundTasks: backgroundTasks.map(({ totalTokens: _tokens, ...task }) => task) }
        : {}),
      ...(children ? { children } : {})
    }
  }

  /** Child-work evidence for a session this feed publishes; a failing sink costs nothing else.
   *  The summary then re-reads the records, which is also what re-folds the parent's row. */
  publishChildWork(sessionId: string, evidence: AgentChildWorkEvidence[]): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session || !this.admitChildWork(sessionId, session, evidence)) {
      return
    }
    this.publish(sessionId)
  }

  /** The session's child records as views, once its parent row has landed; the one read every
   *  surface of them shares. */
  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    try {
      return this.ownership.readChildWork(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return undefined
    }
  }

  private admitChildWork(
    sessionId: string,
    session: StatusFeedSession,
    evidence: AgentChildWorkEvidence[]
  ): boolean {
    try {
      this.ownership.publishChildWork(sessionId, evidence, session.params.provider)
    } catch (error) {
      this.logFailure('child-work-publish', 'child work publish failed', sessionId, error)
      return false
    }
    try {
      this.deps.onChildWorkChanged?.(sessionId)
    } catch (error) {
      this.logFailure('child-work-observer', 'child work observer failed', sessionId, error)
    }
    return true
  }

  /** A failing sink must never cost the subscribers their status event. */
  private sink(
    summary: AgentSessionStatusSummary,
    location?: AgentSessionRecord['location']
  ): void {
    try {
      this.ownership.publish(summary, location)
    } catch (error) {
      this.logFailure('status-sink-publish', 'status sink publish failed', summary.sessionId, error)
    }
  }

  private broadcast(event: AgentSessionStatusEvent): void {
    // A Map skips entries deleted mid-iteration, so a failing subscriber can drop itself here.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  /** A dead transport must not poison every later publication. */
  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
