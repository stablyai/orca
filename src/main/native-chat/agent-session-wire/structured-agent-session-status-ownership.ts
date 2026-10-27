import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import {
  StructuredAgentSessionOpenChildWork,
  type ChildWorkLifetimeToken
} from './structured-agent-session-open-child-work'

export type StructuredAgentSessionStatusSink = {
  publish: (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => void
  forget: (subject: AgentStatusStructuredSessionSubject) => void
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

  publish(summary: AgentSessionStatusSummary, location?: AgentSessionExecutionLocation): void {
    const sink = this.sink()
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
    this.open.observe(sessionId, evidence)
    const subject = this.subjects.get(sessionId)
    if (!subject || !this.landed.has(sessionId)) {
      return
    }
    this.sink()?.publishChildWork?.(subject, evidence, provider)
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
