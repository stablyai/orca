import { StructuredAgentSessionExecutionPublication } from './structured-agent-session-execution-publication'
import type { StructuredAgentSessionSettlementCompletion } from './structured-agent-session-settlement-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { StructuredAgentSessionSendSettlement } from './structured-agent-session-send-settlement'
import {
  createStructuredAgentSessionHostStatusFeed,
  type StructuredAgentSessionStatusSubscriber
} from './structured-agent-session-status-feed'

/** Owns every host-to-client publication edge, including compatibility waits. */
export class StructuredAgentSessionClientDelivery {
  readonly subscribers: AgentSessionSubscribers
  readonly waitForSendSettlement: StructuredAgentSessionSendSettlement['wait']
  readonly execution
  private readonly statusFeed
  private readonly sendSettlement

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    deps: () => StructuredAgentSessionHostDeps,
    observation: (sessionId: string) => 'live' | 'unverifiable' | 'exited' | undefined
  ) {
    this.execution = new StructuredAgentSessionExecutionPublication(sessions, deps, observation)
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({
      sessions,
      now,
      deps,
      readExecution: this.execution.read
    })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.requireJournal(sessionId)
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readExecution: this.execution.read,
      readCommands: (sessionId) => deps().adapter.readCommands?.(sessionId),
      onJournalPublished: (sessionId, journal) => this.publishJournal(sessionId, journal)
    })
  }

  completeSettlement = (result: StructuredAgentSessionSettlementCompletion): void => {
    const session = this.sessions.get(result.sessionId)
    if (session && result.journalChanged) {
      this.subscribers.publish(result.sessionId, session.journal)
    } else {
      this.publishStatus(result.sessionId)
    }
  }

  publishStatus = (sessionId: string): void => {
    this.statusFeed.publish(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) {
      this.subscribers.metadata(sessionId, session.journal)
    }
  }

  publishStatusAndSettlement = (sessionId: string): void => {
    this.publishStatus(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, journal)
    }
  }

  publishRestored = (sessionId: string): void =>
    this.statusFeed.publish(sessionId, undefined, { replay: true })

  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => {
    this.statusFeed.forget(sessionId)
    this.execution.forget(sessionId)
  }

  closeSession(sessionId: string): void {
    this.sendSettlement.closeSession(sessionId)
    this.statusFeed.close(sessionId)
  }

  closeAll(): void {
    this.sendSettlement.closeAll()
  }

  private publishJournal(sessionId: string, journal: AgentSessionJournal): void {
    this.statusFeed.publish(sessionId, journal)
    this.sendSettlement.publish(sessionId, journal)
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return journal
  }
}
