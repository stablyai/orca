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
  private readonly statusFeed
  private readonly sendSettlement

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    deps: () => StructuredAgentSessionHostDeps,
    /** Every edge that can change journal content, including the one that ends a turn. */
    private readonly onJournalPublished: (sessionId: string) => void = () => undefined
  ) {
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({ sessions, now, deps })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.requireJournal(sessionId)
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readCommands: (sessionId) => deps().adapter.readCommands?.(sessionId),
      onJournalPublished: (sessionId, journal) => this.publishJournal(sessionId, journal)
    })
  }

  publishStatus = (sessionId: string): void => this.statusFeed.publish(sessionId)

  publishStatusAndSettlement = (sessionId: string): void => {
    this.statusFeed.publish(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, journal)
    }
  }

  publishRestored = (sessionId: string): void =>
    this.statusFeed.publish(sessionId, undefined, { replay: true })

  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => this.statusFeed.forget(sessionId)

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
    this.onJournalPublished(sessionId)
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return journal
  }
}
