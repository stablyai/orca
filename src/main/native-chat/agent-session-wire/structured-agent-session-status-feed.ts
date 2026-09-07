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
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
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
  params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] }
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  now: () => number
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (summary: AgentSessionStatusSummary, options: { replay: boolean }) => void
}

function summariesEqual(a: AgentSessionStatusSummary, b: AgentSessionStatusSummary): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.status === b.status &&
    // Settled activity changes ranking; streaming active turns must stay quiet.
    (a.status !== 'idle' || a.updatedAt === b.updatedAt) &&
    a.latestPrompt === b.latestPrompt &&
    a.model === b.model &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}

export class StructuredAgentSessionStatusFeed {
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  private readonly published = new Map<string, AgentSessionStatusSummary>()

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
    const items = journal.isReadOnly ? [] : journal.snapshot().items
    const record = this.deps.getRecord(sessionId)
    const providerSession = structuredAgentSessionProviderSessionMetadata(record)
    // The journal has no model: the record's acknowledged options are where an owner
    // handoff or a mid-session switch lands, so the row follows whichever is in force.
    const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
    return {
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: session.params.provider,
      ...projectStructuredAgentSessionStatusSummary(items),
      ...(model ? { model } : {}),
      ...(providerSession ? { providerSession } : {}),
      updatedAt: journal.lastActivityAt() || this.deps.now()
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
