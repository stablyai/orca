// Project host journals for all session lists, retaining settled rows across idle eviction and renderer reload.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  structuredAgentSessionNamingSnapshot,
  type StatusFeedSession,
  type StatusPublication,
  type StructuredAgentSessionStatusSubscriber,
  type StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed-deps'
import {
  renamedStructuredStatusSummary,
  structuredAgentSessionStatusSummary
} from './structured-agent-session-status-summary'
import { structuredStatusChildWork } from './structured-agent-session-status-child-work'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import {
  StructuredAgentSessionStatusOwnership,
  type CapturedChildWorkStops
} from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
export type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'

export type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

export type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed-deps'

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusOwnership(() =>
    this.deps.statusSink?.()
  )
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  // Retain closed-chat names for naming jobs and AI Vault.
  private readonly published = new Map<string, StatusPublication>()
  private readonly acceptedSends = new Map<string, string>()
  private readonly projections = new StructuredAgentSessionJournalProjections((sessionId) =>
    this.deps.replacedRuntime?.(sessionId)
  )

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {}

  private logFailure(scope: string, message: string, sessionId: string, error: unknown): void {
    this.deps.logger.warn(message, { scope, sessionId, error })
  }

  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Naming must stay observable even without a readable journal.
    if (this.deps.namingActiveSessionIds) {
      this.emit(subscriber, structuredAgentSessionNamingSnapshot(this.deps))
    }
    // Reproject before registering: existing readers get changes; the new reader gets one snapshot.
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

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {}
  }

  /** Retain history but clear live authority/Stopping; this host no longer ends that work. */
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
      restartResume: _restartResume,
      ...retained
    } = previous
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.sink(retained)
    this.broadcast({ type: 'status', session: retained })
  }

  publishConversationName(sessionId: string): void {
    this.broadcast(structuredAgentSessionNamingSnapshot(this.deps))
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

  readPublished = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.published.get(sessionId)?.summary

  /** Share per-commit projection with completion and steer-hold readers to avoid repeated snapshots. */
  journalProjection(
    sessionId: string,
    journal?: AgentSessionJournal
  ): StructuredAgentSessionJournalProjection | null {
    const session = this.deps.sessions.get(sessionId)
    const source = journal ?? session?.journal
    return source ? this.projections.read(source, this.deps.getRecord(sessionId), session) : null
  }

  publish(sessionId: string, journal?: AgentSessionJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const source = journal ?? session.journal
    const record = this.deps.getRecord(sessionId)
    const projection = this.projections.read(source, record, session)
    this.retireSettledChildrenOnNewTurn(sessionId, session, projection.acceptedSendKey)
    const summary = structuredAgentSessionStatusSummary({
      sessionId,
      session,
      journal: source,
      record,
      state: projection.state,
      stopping: projection.stopping,
      childWork: this.childWorkFields(sessionId, session.params.provider),
      namingFailure: this.deps.namingFailure?.(sessionId),
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
      this.logFailure('status-observer', 'status observer failed', sessionId, error)
    }
  }

  /** Retain settled children until the next accepted send to reject late revival and allow final outcomes.
   * Live work keeps its owner; provider exit settles unknown, while host release removes all records. */
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

  /** Exclude per-tick usage from global broadcasts; chat background channels retain it. */
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

  /** Publish evidence then refold parent/summary; sink failure must not block other publications. */
  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session || !this.admitChildWork(sessionId, session, evidence, producer)) {
      return
    }
    this.publish(sessionId)
  }

  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    try {
      return this.ownership.readChildWork(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return undefined
    }
  }

  childWorkOpen = (sessionId: string): boolean => this.ownership.childWorkOpen(sessionId)

  captureChildWorkStops = (
    sessionId: string,
    handleIds: readonly string[]
  ): CapturedChildWorkStops => this.ownership.captureChildWorkStops(sessionId, handleIds)

  childWorkIncomplete = (sessionId: string): boolean => {
    try {
      return this.ownership.childWorkIncomplete(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return false
    }
  }

  /** Observer already reports failures; retain host-only facts outside display views. */
  readChildWorkRecords = (sessionId: string): AgentChildWorkRecord[] | undefined =>
    this.ownership.readChildWorkRecords(sessionId)

  private admitChildWork(
    sessionId: string,
    session: StatusFeedSession,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): boolean {
    try {
      this.ownership.publishChildWork(sessionId, evidence, session.params.provider)
    } catch (error) {
      this.logFailure('child-work-publish', 'child work publish failed', sessionId, error)
      return false
    }
    try {
      this.deps.onChildWorkChanged?.(sessionId, producer)
    } catch (error) {
      this.logFailure('child-work-observer', 'child work observer failed', sessionId, error)
    }
    return true
  }

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
    // Map iteration permits failed subscribers to remove themselves.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
