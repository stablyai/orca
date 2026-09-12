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

import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionBackgroundTaskState,
  type AgentSessionStatusEvent,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

type StatusFeedSession = {
  journal: AgentSessionJournal
  params: { location: AgentSessionExecutionLocation; provider: AgentSessionRecord['provider'] }
  hasProviderChild?: boolean
  fence?: number
}

/** Where the host's projections land for readers that see every agent alike (`worktree ps`,
 *  mobile, the hook store's own fanout). `forget` is the roster edge the broadcast cache
 *  deliberately never has. */
export type StructuredAgentSessionStatusSink = {
  publish: (subject: AgentStatusSubject, summary: AgentSessionStatusSummary) => void
  forget: (subject: AgentStatusSubject) => void
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  now: () => number
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (summary: AgentSessionStatusSummary, options: { replay: boolean }) => void
  /** Resolved on every call: the host builds this feed in a field initializer, before its own
   *  deps are assigned. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** Live provider-owned background tasks for the summary, so session lists can
   *  render subagent children. Optional: a provider without the hook projects none. */
  readBackgroundTasks?: (sessionId: string) => AgentSessionBackgroundTaskState | null | undefined
}

function summariesEqual(a: AgentSessionStatusSummary, b: AgentSessionStatusSummary): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.status === b.status &&
    a.hostExecutionOwned === b.hostExecutionOwned &&
    a.rewindBlockedReason === b.rewindBlockedReason &&
    // Settled activity changes ranking; streaming active turns must stay quiet.
    (a.status !== 'idle' || a.updatedAt === b.updatedAt) &&
    a.latestPrompt === b.latestPrompt &&
    a.model === b.model &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    agentSessionBackgroundTasksEqual(a.backgroundTasks, b.backgroundTasks) &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}

/** Wire the host's own deps into a feed; keeps the host at one call site.
 *  `deps` is a thunk because the host builds the feed in a field initializer,
 *  before its constructor parameters are assigned. */
export function createStructuredAgentSessionHostStatusFeed(args: {
  sessions: StructuredAgentSessionStatusFeedDeps['sessions']
  now: () => number
  deps: () => {
    store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
    adapter: {
      backgroundTaskState?: (
        sessionId: string
      ) => AgentSessionBackgroundTaskState | null | undefined
    }
    onSessionStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
    statusSink?: StructuredAgentSessionStatusSink
  }
}): StructuredAgentSessionStatusFeed {
  return new StructuredAgentSessionStatusFeed({
    sessions: args.sessions,
    getRecord: (sessionId) => args.deps().store.getRecord(sessionId),
    now: args.now,
    onStatusChanged: (summary, options) => args.deps().onSessionStatusChanged?.(summary, options),
    readBackgroundTasks: (sessionId) => args.deps().adapter.backgroundTaskState?.(sessionId),
    // Resolved per call for the same reason the other deps are: the host builds this feed in a
    // field initializer, before its constructor parameters are assigned.
    statusSink: () => args.deps().statusSink
  })
}

export class StructuredAgentSessionStatusFeed {
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  private readonly published = new Map<string, AgentSessionStatusSummary>()
  private readonly publishedSubjects = new Map<string, AgentStatusSubject>()
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly journalProjections = new WeakMap<
    AgentSessionJournal,
    {
      epoch: string
      sequence: number
      readOnly: boolean
      fence: number | undefined
      summary: ReturnType<typeof projectStructuredAgentSessionStatusSummary>
    }
  >()

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
    const subject = this.publishedSubjects.get(sessionId)
    if (!subject) {
      return
    }
    try {
      this.deps.statusSink?.()?.forget(subject)
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
    const { hostExecutionOwned: _hostExecutionOwned, ...retained } = previous
    this.published.set(sessionId, retained)
    this.broadcast({
      type: 'status',
      session: retained
    })
    const location = this.deps.sessions.get(sessionId)?.params.location
    if (location) {
      this.sink(retained, location)
    } else {
      this.sinkSubject(retained, this.publishedSubjects.get(sessionId))
    }
  }

  /** Re-projects one session after its journal changed; equal projections are not re-sent. */
  publish(sessionId: string, journal?: AgentSessionJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const summary = this.summaryFor(sessionId, session, journal ?? session.journal)
    const previous = this.published.get(sessionId)
    if (previous && summariesEqual(previous, summary)) {
      return
    }
    this.published.set(sessionId, summary)
    this.broadcast({ type: 'status', session: summary })
    this.sink(summary, session.params.location)
    try {
      this.deps.onStatusChanged?.(summary, { replay: options?.replay === true })
    } catch (error) {
      // An observer must never cost the subscribers their status event.
      console.warn('[structured-session-status] status observer failed', error)
    }
  }

  private summaryFor(
    sessionId: string,
    session: StatusFeedSession,
    journal: AgentSessionJournal
  ): AgentSessionStatusSummary {
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
        )
      }
      this.journalProjections.set(journal, projection)
    }
    const record = this.deps.getRecord(sessionId)
    const providerSession = structuredAgentSessionProviderSessionMetadata(record)
    // The journal has no model: the record's acknowledged options are where an owner
    // handoff or a mid-session switch lands, so the row follows whichever is in force.
    const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
    // Usage is dropped here on purpose: a `task_progress` tick would otherwise fail the
    // equality check and re-broadcast a full summary to every remote subscriber for a
    // number no session list renders. Tokens stay live on the background-task channel.
    const backgroundTasks = this.deps
      .readBackgroundTasks?.(sessionId)
      ?.tasks?.map(({ totalTokens: _totalTokens, ...task }) => task)
    return {
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: session.params.provider,
      ...(session.hasProviderChild ? { hostExecutionOwned: true as const } : {}),
      ...projection.summary,
      ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
        ? { rewindBlockedReason: 'outcome-unknown' as const }
        : {}),
      ...(model ? { model } : {}),
      ...(backgroundTasks && backgroundTasks.length > 0 ? { backgroundTasks } : {}),
      ...(providerSession ? { providerSession } : {}),
      updatedAt: journal.lastActivityAt() || this.deps.now()
    }
  }

  /** A failing sink must never cost the subscribers their status event. */
  private sink(
    summary: AgentSessionStatusSummary,
    location: AgentSessionExecutionLocation | undefined
  ): void {
    const sink = this.deps.statusSink?.()
    if (!sink || !location) {
      return
    }
    const subject = makeStructuredAgentStatusSubject(location, summary.sessionId)
    this.publishedSubjects.set(summary.sessionId, subject)
    this.sinkSubject(summary, subject, sink)
  }

  private sinkSubject(
    summary: AgentSessionStatusSummary,
    subject: AgentStatusSubject | undefined,
    resolvedSink?: StructuredAgentSessionStatusSink
  ): void {
    const sink = resolvedSink ?? this.deps.statusSink?.()
    if (!sink || !subject) {
      return
    }
    try {
      sink.publish(subject, summary)
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
