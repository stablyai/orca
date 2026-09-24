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
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChildPhase } from './structured-agent-session-adapter'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import {
  newestRootTurnId,
  structuredStatusChildWork
} from './structured-agent-session-status-child-work'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'
import {
  StructuredAgentSessionStatusOwnership,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

type StatusFeedSession = {
  journal: AgentSessionJournal
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  hasProviderChild?: boolean
  providerChildPhase?: StructuredAgentSessionProviderChildPhase
  fence?: number
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  now: () => number
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (summary: AgentSessionStatusSummary, options: { replay: boolean }) => void
  /** Resolved on every call: the host builds this feed in a field initializer, before its own
   *  deps are assigned. The sink holds the session's child records; the summary reads them there. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** The session's child records changed, so every other reader of them republishes. */
  onChildWorkChanged?: (sessionId: string) => void
}

/** Wire the host's own deps into a feed; keeps the host at one call site.
 *  `deps` is a thunk because the host builds the feed in a field initializer,
 *  before its constructor parameters are assigned. */
export function createStructuredAgentSessionHostStatusFeed(args: {
  sessions: StructuredAgentSessionStatusFeedDeps['sessions']
  now: () => number
  deps: () => {
    store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
    onSessionStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
    statusSink?: StructuredAgentSessionStatusSink
  }
  onChildWorkChanged?: (sessionId: string) => void
}): StructuredAgentSessionStatusFeed {
  return new StructuredAgentSessionStatusFeed({
    sessions: args.sessions,
    getRecord: (sessionId) => args.deps().store.getRecord(sessionId),
    now: args.now,
    onStatusChanged: (summary, options) => args.deps().onSessionStatusChanged?.(summary, options),
    // Resolved per call for the same reason the other deps are: the host builds this feed in a
    // field initializer, before its constructor parameters are assigned.
    statusSink: () => args.deps().statusSink,
    ...(args.onChildWorkChanged ? { onChildWorkChanged: args.onChildWorkChanged } : {})
  })
}

type JournalProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  fence: number | undefined
  summary: ReturnType<typeof projectStructuredAgentSessionStatusSummary>
  rootTurnId: string | null
}

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusOwnership(() =>
    this.deps.statusSink?.()
  )
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  private readonly published = new Map<string, AgentSessionStatusSummary>()
  /** The newest root turn each session was last projected with; a new one retires settled children. */
  private readonly rootTurns = new Map<string, string | null>()
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly journalProjections = new WeakMap<AgentSessionJournal, JournalProjection>()

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {}

  /** Opens with every session this host has projected, live ones re-read, then only changes. */
  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Re-project before registering: a change found here has to reach the subscribers that
    // already read the old value, and the arriving one carries it in its snapshot instead.
    for (const [sessionId] of this.deps.sessions) {
      this.publish(sessionId, undefined, { replay: true })
    }
    this.subscribers.set(subscriber.id, subscriber)
    this.emit(subscriber, { type: 'snapshot', sessions: [...this.published.values()] })
    return () => this.unsubscribe(subscriber.id)
  }

  /** The host stopped holding the session: ownership leaves the retained projection, and the
   *  row leaves the sink. `published` keeps the projection for reload history. */
  close(sessionId: string): void {
    this.revokeLive(sessionId)
    this.forget(sessionId)
  }

  /** The sink lists what is running; a forgotten session must not be in it. */
  forget(sessionId: string): void {
    this.rootTurns.delete(sessionId)
    try {
      this.ownership.forget(sessionId)
    } catch (error) {
      console.warn('[structured-session-status] status sink forget failed', error)
    }
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

  /** Revoke live execution authority while retaining the last projection for reload history. */
  revokeLive(sessionId: string): void {
    const previous = this.published.get(sessionId)
    if (!previous) {
      return
    }
    // The store forgets a closed session's child records with its row, so the retained
    // projection must not keep listing them.
    const {
      hostExecutionOwned: _hostExecutionOwned,
      children: _children,
      backgroundTasks: _backgroundTasks,
      ...retained
    } = previous
    this.published.set(sessionId, retained)
    this.sink(retained)
    this.broadcast({
      type: 'status',
      session: retained
    })
  }

  /** Re-projects one session after its journal changed; equal projections are not re-sent. */
  publish(sessionId: string, journal?: AgentSessionJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const projection = this.projectionFor(session, journal ?? session.journal)
    this.retireSettledChildrenOnNewTurn(sessionId, session, projection.rootTurnId)
    const summary = this.summaryFor(sessionId, session, journal ?? session.journal, projection)
    const previous = this.published.get(sessionId)
    if (previous && structuredStatusSummariesEqual(previous, summary)) {
      if (!this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, session.params.location)
      }
      return
    }
    this.published.set(sessionId, summary)
    this.sink(summary, session.params.location)
    this.broadcast({ type: 'status', session: summary })
    try {
      this.deps.onStatusChanged?.(summary, { replay: options?.replay === true })
    } catch (error) {
      // An observer must never cost the subscribers their status event.
      console.warn('[structured-session-status] status observer failed', error)
    }
  }

  private projectionFor(
    session: StatusFeedSession,
    journal: AgentSessionJournal
  ): JournalProjection {
    // An unreadable journal projects as "no turn": the chat itself shows the reset.
    const cursor = journal.cursor()
    const readOnly = journal.isReadOnly
    const fence = session.fence
    let projection = this.journalProjections.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.readOnly !== readOnly ||
      projection.fence !== fence
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = readOnly ? null : journal.snapshot()
      projection = {
        ...cursor,
        readOnly,
        fence,
        summary: projectStructuredAgentSessionStatusSummary(
          snapshot?.items ?? [],
          snapshot?.submissions ?? [],
          fence
        ),
        rootTurnId: newestRootTurnId(snapshot?.items ?? [])
      }
      this.journalProjections.set(journal, projection)
    }
    return projection
  }

  /** Finished children stay listed, with their outcome, until the session's own next turn. */
  private retireSettledChildrenOnNewTurn(
    sessionId: string,
    session: StatusFeedSession,
    rootTurnId: string | null
  ): void {
    const seen = this.rootTurns.has(sessionId)
    const previous = this.rootTurns.get(sessionId)
    this.rootTurns.set(sessionId, rootTurnId)
    if (!seen || rootTurnId === null || rootTurnId === previous) {
      return
    }
    this.admitChildWork(sessionId, session, [{ type: 'turn-started', observedAt: this.deps.now() }])
  }

  private summaryFor(
    sessionId: string,
    session: StatusFeedSession,
    journal: AgentSessionJournal,
    projection: JournalProjection
  ): AgentSessionStatusSummary {
    const record = this.deps.getRecord(sessionId)
    const providerSession = structuredAgentSessionProviderSessionMetadata(record)
    // The journal has no model: the record's acknowledged options are where a mid-session
    // switch lands, so the row follows whichever is in force.
    const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
    // Usage is dropped here on purpose: a `task_progress` tick would otherwise fail the
    // equality check and re-broadcast a full summary to every remote subscriber for a
    // number no session list renders. Tokens stay live on the background-task channel.
    const { children, backgroundTasks } = structuredStatusChildWork(
      this.readChildWork(sessionId),
      session.params.provider
    )
    return {
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: session.params.provider,
      ...(session.hasProviderChild
        ? {
            hostExecutionOwned: true as const,
            ...(session.providerChildPhase
              ? { hostExecutionPhase: session.providerChildPhase }
              : {})
          }
        : {}),
      ...projection.summary,
      ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
        ? { rewindBlockedReason: 'outcome-unknown' as const }
        : {}),
      ...(model ? { model } : {}),
      ...(backgroundTasks && backgroundTasks.length > 0
        ? { backgroundTasks: backgroundTasks.map(({ totalTokens: _tokens, ...task }) => task) }
        : {}),
      ...(children ? { children } : {}),
      ...(providerSession ? { providerSession } : {}),
      updatedAt: journal.lastActivityAt() || this.deps.now()
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
      console.warn('[structured-session-status] child work read failed', error)
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
      console.warn('[structured-session-status] child work publish failed', error)
      return false
    }
    try {
      this.deps.onChildWorkChanged?.(sessionId)
    } catch (error) {
      console.warn('[structured-session-status] child work observer failed', error)
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
      console.warn('[structured-session-status] status sink publish failed', error)
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
