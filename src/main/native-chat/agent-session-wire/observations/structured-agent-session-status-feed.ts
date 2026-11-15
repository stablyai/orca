import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import { createSavedStructuredStatusGroup } from './structured-agent-session-saved-status'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { createStructuredAgentSessionStatusReader } from './structured-agent-session-status-reader'
import { StructuredAgentSessionStatusSubscriptions } from './structured-agent-session-status-subscriptions'
import {
  structuredAgentSessionNamingSnapshot,
  notifyStructuredStatusObservers,
  notifyStructuredStatusPublication,
  type StatusFeedSession,
  type StatusPublication,
  type StructuredAgentSessionStatusSubscriber,
  type StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed-deps'
import {
  renamedStructuredStatusSummary,
  releasedStructuredStatusSummary,
  retainedStructuredStatusSummaries,
  structuredAgentSessionStatusSummary
} from './structured-agent-session-status-summary'
import { structuredStatusChildWorkFields } from './structured-agent-session-status-child-work'
import type { StructuredAgentSessionJournalProjection } from './structured-agent-session-status-journal-projection'
import {
  permissionReportOnly,
  structuredStatusSummariesEqual
} from './structured-agent-session-status-summary-equality'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import {
  StructuredAgentSessionStatusOwnership,
  type StructuredAgentSessionStatusPublisher
} from './structured-agent-session-status-ownership'

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusOwnership(() =>
    this.deps.statusSink?.()
  )
  private readonly subscriptions = new StructuredAgentSessionStatusSubscriptions()
  private readonly broadcast = this.subscriptions.broadcast
  // Never evicted: chats are named only while in here, and AI Vault reads closed ones' names here.
  private readonly published = new Map<string, StatusPublication>()
  private readonly acceptedSends = new Map<string, string>()
  readonly journalProjection

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {
    this.journalProjection = createStructuredAgentSessionStatusReader(deps, this.publish.bind(this))
  }

  private logFailure(scope: string, message: string, sessionId: string, error: unknown): void {
    this.deps.logger.warn(message, { scope, sessionId, error })
  }

  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Naming completion must be observable even if a held journal cannot be read.
    if (this.deps.namingActiveSessionIds || this.deps.listConversations) {
      this.subscriptions.emit(subscriber, structuredAgentSessionNamingSnapshot(this.deps))
    }
    // Reproject before registering: existing readers get changes; the new reader gets one snapshot.
    for (const [sessionId] of this.deps.sessions) {
      this.publish(sessionId, undefined, { replay: true })
    }
    const unsubscribe = this.subscriptions.add(subscriber)
    this.subscriptions.emit(subscriber, {
      type: 'snapshot',
      sessions: retainedStructuredStatusSummaries(this.published.values(), this.deps)
    })
    return unsubscribe
  }

  /** Revoke live ownership/remove sink children while retaining reload history. */
  close(sessionId: string): void {
    this.revokeLive(sessionId)
    this.forget(sessionId)
  }

  /** Drop sink roster membership and refresh retained child projections. */
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

  /** Retain history but clear live authority/Stopping; this host no longer ends that work. */
  revokeLive(sessionId: string): void {
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    if (!previous) {
      return
    }
    const retained = releasedStructuredStatusSummary(previous)
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.sink(retained)
    this.broadcast({ type: 'status', session: retained })
  }

  /** Naming activity is published even when the chat has no retained status row. */
  publishConversationName(sessionId: string): void {
    this.broadcast(structuredAgentSessionNamingSnapshot(this.deps, sessionId))
    this.publishRecordNotes(sessionId)
  }

  publishRecordNotes(sessionId: string): void {
    if (this.deps.sessions.has(sessionId)) {
      this.publish(sessionId)
      return
    }
    const publication = this.published.get(sessionId)
    const summary =
      publication && renamedStructuredStatusSummary(publication.summary, this.deps, sessionId)
    if (publication && summary) {
      this.published.set(sessionId, { ...publication, summary })
      this.broadcast({ type: 'status', session: summary })
    }
  }

  readPublished = (sessionId: string) => this.published.get(sessionId)?.summary

  /** Seed unopened lists and the phone sink without reactions or saved-status writes. */
  publishSavedGroup = createSavedStructuredStatusGroup(
    (id) => this.deps.sessions.has(id),
    this.published,
    this.sink.bind(this),
    this.broadcast.bind(this),
    () => this.deps.statusSink?.()
  )

  publish(
    sessionId: string,
    journal?: AgentSessionJournal | SqlAgentSessionJournal,
    options?: { replay?: boolean },
    observed?: (projection: StructuredAgentSessionJournalProjection) => void
  ): void | Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const source = journal ?? session.journal
    const reading = this.journalProjection(
      sessionId,
      source,
      (value) => {
        const current = this.deps.sessions.get(sessionId)
        if (current?.journal === source) {
          this.publishProjection(sessionId, current, value, options)
          try {
            observed?.(value)
          } catch (error) {
            this.logFailure(
              'status-projection-observer',
              'observing chat status failed',
              sessionId,
              error
            )
          }
        }
      },
      () => this.publish(sessionId, undefined, options, observed)
    )
    if (reading instanceof Promise) {
      return reading.then(
        () => {},
        (error: unknown) =>
          this.logFailure('status-read', 'reading chat status failed', sessionId, error)
      )
    }
  }

  private publishProjection(
    sessionId: string,
    session: StatusFeedSession,
    projection: StructuredAgentSessionJournalProjection,
    options?: { replay?: boolean }
  ): void {
    const record = this.deps.getConversation(sessionId)
    this.retireSettledChildrenOnNewTurn(sessionId, session, projection.acceptedSendKey)
    const summary = structuredAgentSessionStatusSummary({
      sessionId,
      session,
      starting: this.deps.starting?.(sessionId),
      lastActivityAt: projection.lastActivityAt,
      record,
      state: projection.state,
      stopping: projection.stopping,
      usageLimitContinue: this.deps.readUsageLimitContinue?.(sessionId, projection.usageLimitCut),
      childWork: this.childWorkFields(sessionId, session.params.provider),
      namingFailure: this.deps.namingFailure?.(sessionId),
      now: this.deps.now
    })
    notifyStructuredStatusPublication(this.deps, summary)
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    const summaryChanged = !previous || !structuredStatusSummariesEqual(previous, summary)
    const inputChanged = publication?.firstInputSubmissionKey !== projection.firstInputSubmissionKey
    const reportOnly = !inputChanged && permissionReportOnly(previous, summary)
    if (!summaryChanged && !inputChanged) {
      if (!this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, this.deps.rowRetired?.(sessionId) ? undefined : session.params.location)
      }
      return
    }
    this.published.set(sessionId, {
      summary,
      firstInputSubmissionKey: projection.firstInputSubmissionKey
    })
    if (summaryChanged) {
      if (!reportOnly || !this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, this.deps.rowRetired?.(sessionId) ? undefined : session.params.location)
      }
      this.broadcast({ type: 'status', session: summary })
    }
    notifyStructuredStatusObservers(this.deps, summary, previous, {
      reportOnly,
      replay: options?.replay === true,
      firstInputSubmissionKey: projection.firstInputSubmissionKey
    })
  }

  /** Retain settled children until the next accepted send to reject late revival and allow final outcomes.
   * Live work keeps its owner; provider exit settles unknown, while host release removes all records. */
  private retireSettledChildrenOnNewTurn(
    sessionId: string,
    session: StatusFeedSession,
    acceptedSendKey: string
  ): void {
    const previous = this.acceptedSends.get(sessionId)
    this.acceptedSends.set(sessionId, acceptedSendKey)
    if (previous !== undefined && acceptedSendKey !== previous) {
      this.ownership.admitChildWork(this.deps, sessionId, session, [
        { type: 'turn-started', observedAt: this.deps.now() }
      ])
    }
  }

  /** Exclude per-tick usage from global broadcasts; chat background channels retain it. */
  private childWorkFields = (
    sessionId: string,
    provider: StatusFeedSession['params']['provider']
  ): Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'> =>
    structuredStatusChildWorkFields(this.readChildWork(sessionId), provider)

  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer,
    observed?: (projection: StructuredAgentSessionJournalProjection) => void
  ): void {
    this.ownership.publishChildWorkAfterWrites(
      this.deps,
      sessionId,
      evidence,
      producer,
      (session) => {
        if (this.ownership.admitChildWork(this.deps, sessionId, session, evidence, producer)) {
          this.publish(sessionId, session.journal, undefined, observed)
        }
      }
    )
  }

  drainChildWork = (sessionId?: string): Promise<void> =>
    this.deps.drainChildWork?.(sessionId) ?? Promise.resolve()

  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    try {
      return this.ownership.readChildWork(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return undefined
    }
  }

  childWorkOpen = (sessionId: string): boolean => this.ownership.childWorkOpen(sessionId)

  captureChildWorkStops = (sessionId: string, handleIds: readonly string[]) =>
    this.ownership.captureChildWorkStops(sessionId, handleIds)

  childWorkIncomplete = (sessionId: string): boolean => {
    try {
      return this.ownership.childWorkIncomplete(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return false
    }
  }

  readChildWorkRecords = (sessionId: string): AgentChildWorkRecord[] | undefined =>
    this.ownership.readChildWorkRecords(sessionId)

  private sink(
    summary: AgentSessionStatusSummary,
    location?: StatusFeedSession['params']['location'],
    publisher?: StructuredAgentSessionStatusPublisher
  ): void {
    try {
      this.ownership.publish(summary, location, publisher)
    } catch (error) {
      this.logFailure('status-sink-publish', 'status sink publish failed', summary.sessionId, error)
    }
  }
}
