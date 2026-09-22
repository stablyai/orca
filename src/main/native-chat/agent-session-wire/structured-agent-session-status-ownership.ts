import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'

export type StructuredAgentSessionStatusSink = {
  publish: (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => void
  forget: (subject: AgentStatusStructuredSessionSubject) => void
}

/** Retain the owner address because record removal may precede the final status callback. */
export class StructuredAgentSessionStatusOwnership {
  private readonly subjects = new Map<string, AgentStatusStructuredSessionSubject>()
  // Why separate from `subjects`: the address must survive a throwing publish so teardown can still
  // forget a row that did land, but "we hold an address" is not evidence the row is there. Only a
  // publish that returned proves that, and only that proof may suppress the re-offer below.
  private readonly landed = new Set<string>()

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

  forget(sessionId: string): void {
    const subject = this.subjects.get(sessionId)
    if (!subject) {
      return
    }
    this.landed.delete(sessionId)
    this.sink()?.forget(subject)
    this.subjects.delete(sessionId)
  }
}
