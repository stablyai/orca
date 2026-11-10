import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../../shared/agent-status/contracts/agent-status-subject'
import {
  StructuredAgentSessionOpenChildWork,
  type ChildWorkLifetimeToken
} from './structured-agent-session-open-child-work'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import type {
  StatusFeedSession,
  StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed-deps'

export type StructuredAgentSessionStatusPublisher = {
  publish: (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => void
  forget: (subject: AgentStatusStructuredSessionSubject) => void
}

export type StructuredAgentSessionStatusSink = StructuredAgentSessionStatusPublisher & {
  withSavedStatusGroup?: (visit: (sink: StructuredAgentSessionStatusPublisher) => void) => void
  /** Address evidence by the parent row’s landed subject. */
  publishChildWork?: (
    subject: AgentStatusStructuredSessionSubject,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ) => void
  readChildWork?: (subject: AgentStatusStructuredSessionSubject) => AgentChildWorkView[]
  /** Includes host-only facts omitted from views. */
  readChildWorkRecords?: (subject: AgentStatusStructuredSessionSubject) => AgentChildWorkRecord[]
  readChildWorkHandles?: (subject: AgentStatusStructuredSessionSubject) => ReadonlySet<string>
}

export type CapturedChildWorkStops = {
  current: (handleId: string) => boolean
  acknowledge: (evidence: readonly AgentChildWorkEvidence[]) => void
}

/** Retain addresses through record removal for final callbacks. */
export class StructuredAgentSessionStatusOwnership {
  private readonly subjects = new Map<string, AgentStatusStructuredSessionSubject>()
  // Retain failed-publish addresses for cleanup, but only returned publication proves landing.
  private readonly landed = new Set<string>()
  private readonly open = new StructuredAgentSessionOpenChildWork()

  constructor(private readonly sink: () => StructuredAgentSessionStatusSink | undefined) {}

  matchesLocation(sessionId: string, location: AgentSessionExecutionLocation): boolean {
    const subject = this.subjects.get(sessionId)
    return (
      this.landed.has(sessionId) &&
      subject?.executionHostId === location.executionHostId &&
      subject.wslDistro === location.wslDistro &&
      subject.workspaceId === location.workspaceId &&
      subject.workspaceKind === location.workspaceKind
    )
  }

  publish(
    summary: AgentSessionStatusSummary,
    location?: AgentSessionExecutionLocation,
    sink: StructuredAgentSessionStatusPublisher | undefined = this.sink()
  ): void {
    if (!sink || (!location && !this.subjects.has(summary.sessionId))) {
      return
    }
    const subject = location
      ? parseAgentStatusSubject({
          ...location,
          kind: 'structured-session',
          sessionId: summary.sessionId
        })
      : this.subjects.get(summary.sessionId)
    if (!subject || subject.kind !== 'structured-session') {
      throw new Error('Structured status requires its full trusted execution location')
    }
    const previous = this.subjects.get(summary.sessionId)
    if (
      previous &&
      serializeAgentStatusSubject(previous) !== serializeAgentStatusSubject(subject)
    ) {
      sink.forget(previous)
    }
    this.subjects.set(summary.sessionId, subject)
    this.landed.delete(summary.sessionId)
    sink.publish(summary, subject)
    this.landed.add(summary.sessionId)
  }

  /** Publish children only after parent landing; track all provider edges independently of display admission. */
  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ): void {
    this.observeChildWork(sessionId, evidence)
    this.deliverChildWork(sessionId, evidence, provider)
  }

  establish(
    sessionId: string,
    location: AgentSessionExecutionLocation,
    provider: AgentSessionRecord['provider'],
    now: number
  ): void {
    if (!this.matchesLocation(sessionId, location)) {
      this.publish(
        {
          sessionId,
          workspaceId: location.workspaceId,
          agent: provider,
          status: null,
          latestPrompt: '',
          runtimePermission: null,
          updatedAt: now
        },
        location
      )
    }
  }

  publishChildWorkAfterWrites(
    deps: StructuredAgentSessionStatusFeedDeps,
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer: StructuredAgentSessionChildWorkProducer | undefined,
    publish: (session: StatusFeedSession) => void
  ): void {
    const session = deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.observeChildWork(sessionId, evidence)
    const apply = () => {
      if (deps.sessions.get(sessionId) === session && !deps.rowRetired?.(sessionId)) {
        try {
          this.establish(sessionId, session.params.location, session.params.provider, deps.now())
        } catch (error) {
          deps.logger.warn('status sink publish failed', {
            scope: 'status-sink-publish',
            sessionId,
            error
          })
        }
        publish(session)
      }
    }
    if (producer?.publishChildWork) {
      producer.publishChildWork(evidence, apply)
    } else {
      apply()
    }
  }

  observeChildWork(sessionId: string, evidence: readonly AgentChildWorkEvidence[]): void {
    this.open.observe(sessionId, evidence)
  }

  deliverChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ): void {
    const subject = this.subjects.get(sessionId)
    if (!subject || !this.landed.has(sessionId)) {
      return
    }
    this.sink()?.publishChildWork?.(subject, evidence, provider)
  }

  admitChildWork(
    deps: StructuredAgentSessionStatusFeedDeps,
    sessionId: string,
    session: StatusFeedSession,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): boolean {
    try {
      this.deliverChildWork(sessionId, evidence, session.params.provider)
    } catch (error) {
      deps.logger.warn('child work publish failed', {
        scope: 'child-work-publish',
        sessionId,
        error
      })
      return false
    }
    try {
      deps.onChildWorkChanged?.(sessionId, producer)
    } catch (error) {
      deps.logger.warn('child work observer failed', {
        scope: 'child-work-observer',
        sessionId,
        error
      })
    }
    return true
  }

  /** Capture lifetimes before provider awaits so Stop cannot close replacement runs. */
  captureChildWorkStops(sessionId: string, handleIds: readonly string[]): CapturedChildWorkStops {
    const captured = new Map<string, ChildWorkLifetimeToken | undefined>()
    for (const handleId of handleIds) {
      captured.set(handleId, this.open.capture(sessionId, handleId))
    }
    return {
      current: (handleId) =>
        captured.has(handleId) && this.open.matches(sessionId, handleId, captured.get(handleId)),
      acknowledge: (evidence) => {
        for (const edge of evidence) {
          if (edge.type === 'stop-acknowledged') {
            const token = captured.get(edge.handleId)
            if (token) {
              this.open.stopped(sessionId, edge.handleId, token)
            }
          }
        }
      }
    }
  }

  childWorkOpen(sessionId: string): boolean {
    return this.open.hasOpen(sessionId)
  }

  /** Includes provider work rejected by display storage. */
  childWorkIncomplete(sessionId: string): boolean {
    const open = this.open.handles(sessionId)
    if (!open) {
      return false
    }
    const read = this.sink()?.readChildWorkHandles
    if (!read) {
      return true
    }
    const subject = this.subjects.get(sessionId)
    const recorded = subject && this.landed.has(sessionId) ? read(subject) : new Set<string>()
    return [...open].some((handleId) => !recorded.has(handleId))
  }

  /** No parent landing means no stored children to read. */
  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    const subject = this.subjects.get(sessionId)
    return subject && this.landed.has(sessionId) ? this.sink()?.readChildWork?.(subject) : undefined
  }

  readChildWorkRecords(sessionId: string): AgentChildWorkRecord[] | undefined {
    const subject = this.subjects.get(sessionId)
    return subject && this.landed.has(sessionId)
      ? this.sink()?.readChildWorkRecords?.(subject)
      : undefined
  }

  forget(sessionId: string): void {
    this.open.forget(sessionId)
    const subject = this.subjects.get(sessionId)
    if (!subject) {
      return
    }
    this.landed.delete(sessionId)
    this.sink()?.forget(subject)
    this.subjects.delete(sessionId)
  }
}
