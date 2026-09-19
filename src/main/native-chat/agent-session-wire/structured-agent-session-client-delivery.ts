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
import {
  StructuredTurnCompletionFeed,
  type StructuredTurnCompletionSubscriber
} from './structured-turn-completion-feed'

/** Owns every host-to-client publication edge, including compatibility waits. */
export class StructuredAgentSessionClientDelivery {
  readonly subscribers: AgentSessionSubscribers
  readonly waitForSendSettlement: StructuredAgentSessionSendSettlement['wait']
  private readonly statusFeed
  private readonly turnCompletions
  private readonly sendSettlement

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    deps: () => StructuredAgentSessionHostDeps
  ) {
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({ sessions, now, deps })
    this.turnCompletions = new StructuredTurnCompletionFeed({ sessions, now })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.requireJournal(sessionId)
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readCommands: (sessionId) => deps().adapter.readCommands?.(sessionId),
      onJournalPublished: (sessionId, journal) => this.publishJournal(sessionId, journal)
    })
  }

  // Why every status edge only baselines: a status publication is not a journal commit, so a
  // terminal turn first seen here is one this feed was not watching when it landed. Baselining is
  // also how an attaching session gets its live-only start, since attach publishes status.
  publishStatus = (sessionId: string): void => {
    this.statusFeed.publish(sessionId)
    this.turnCompletions.baseline(sessionId)
  }

  publishStatusAndSettlement = (sessionId: string): void => {
    this.publishStatus(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, journal)
    }
  }

  publishRestored = (sessionId: string): void => {
    this.statusFeed.publish(sessionId, undefined, { replay: true })
    this.turnCompletions.baseline(sessionId)
  }

  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => this.statusFeed.forget(sessionId)

  subscribeTurnCompletions = (subscriber: StructuredTurnCompletionSubscriber): (() => void) =>
    this.turnCompletions.subscribe(subscriber)

  closeSession(sessionId: string): void {
    this.sendSettlement.closeSession(sessionId)
    this.statusFeed.close(sessionId)
    this.turnCompletions.forget(sessionId)
  }

  closeAll(): void {
    this.sendSettlement.closeAll()
  }

  private publishJournal(sessionId: string, journal: AgentSessionJournal): void {
    this.statusFeed.publish(sessionId, journal)
    // The one edge that may announce a completion: this is journal commit.
    this.turnCompletions.observe(sessionId, journal)
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
