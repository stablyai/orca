import { tryReadQueueSummary } from './structured-agent-session-queue-summary'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  structuredQueueSendGate,
  tryReadQueuePublication
} from './structured-agent-session-queued-publication'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { StructuredAgentSessionSendSettlement } from './structured-agent-session-send-settlement'
import type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed'
import { createStructuredAgentSessionHostStatusFeed } from './structured-agent-session-host-status-feed'
import {
  StructuredAgentSessionTurnCompletionFeed,
  type StructuredAgentSessionTurnCompletionSubscriber
} from './structured-agent-session-turn-completion-feed'

/** Owns every host-to-client publication edge, including compatibility waits. */
export class StructuredAgentSessionClientDelivery {
  readonly subscribers: AgentSessionSubscribers
  readonly waitForSendSettlement: StructuredAgentSessionSendSettlement['wait']
  private stopAtRestCommandUpdates: () => void = () => undefined
  private readonly statusFeed
  private readonly turnCompletionFeed
  private readonly sendSettlement

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    private readonly deps: () => StructuredAgentSessionHostDeps,
    private readonly onJournalActivity: (sessionId: string) => void,
    onAgentStarted: (sessionId: string) => void,
    /** A session's child records changed; the chat strip republishes from them. */
    onChildWorkChanged: (sessionId: string) => void,
    // Required: an opening frame without the roster reads as "no tasks" to current clients.
    readBackgroundTasks: NonNullable<SubscriberFieldHooks['readBackgroundTasks']>,
    readJournal: (sessionId: string) => Promise<AgentSessionJournal>
  ) {
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({
      sessions,
      now,
      deps,
      onAgentStarted,
      onChildWorkChanged
    })
    this.turnCompletionFeed = new StructuredAgentSessionTurnCompletionFeed({
      sessions,
      now,
      readStatusState: (sessionId, journal) =>
        this.statusFeed.journalProjection(sessionId, journal)?.state ?? null
    })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.requireJournal(sessionId)
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readJournal,
      readCommands: (sessionId) => this.readCommands(sessionId),
      readQueuePublication: (sessionId, queueView) =>
        (queueView === 'paged-v1' ? tryReadQueueSummary : tryReadQueuePublication)(
          sessions.get(sessionId)?.journal,
          structuredQueueSendGate(this.deps().store, sessionId)
        ),
      readBackgroundTasks,
      onJournalPublished: (sessionId, journal) => this.publishJournal(sessionId, journal)
    })
  }

  /** Re-sends the `/` surface whenever the provider's at-rest one changes. */
  watchAtRestCommands(adapter: StructuredAgentSessionHostDeps['adapter']): void {
    this.stopAtRestCommandUpdates =
      adapter.atRestCommands?.onChange(() => this.subscribers.republishCommands()) ??
      (() => undefined)
  }

  /** What the running agent reports; with none running, what the provider would read at rest. */
  readCommands(sessionId: string) {
    const { adapter, store } = this.deps()
    const live = adapter.readCommands?.(sessionId)
    if (live !== undefined) {
      return live
    }
    const record = store.getRecord(sessionId)
    return record ? adapter.atRestCommands?.read(record) : undefined
  }

  publishStatus = (sessionId: string): void => this.statusFeed.publish(sessionId)

  publishConversationName = (sessionId: string): void =>
    this.statusFeed.publishConversationName(sessionId)

  publishChildWork = (sessionId: string, evidence: AgentChildWorkEvidence[]): void =>
    this.statusFeed.publishChildWork(sessionId, evidence)

  /** What the feed publishes as `stopping`: only a working session is still being stopped. */
  readStopping = (sessionId: string): boolean => {
    const projection = this.statusFeed.journalProjection(sessionId)
    return projection?.stopping === true && projection.state.summary.status === 'working'
  }

  readChildWork = (sessionId: string): AgentChildWorkView[] | undefined =>
    this.statusFeed.readChildWork(sessionId)

  publishStatusAndSettlement = (sessionId: string): void => {
    this.statusFeed.publish(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, journal)
    }
  }

  publishRestored = (sessionId: string): void => {
    this.statusFeed.publish(sessionId, undefined, { replay: true })
    this.turnCompletionFeed.observe(sessionId, undefined, { historical: true })
  }

  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => this.statusFeed.forget(sessionId)

  readStatusSummary = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.statusFeed.readPublished(sessionId)

  subscribeTurnCompletions = (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ): (() => void) => this.turnCompletionFeed.subscribe(subscriber)

  /** The conversation's handle closed. Its status row stays in every session list; the
   *  agent-status store keeps it too while the chat still has a tab to show it in. */
  closeSession(sessionId: string, options: { listed: boolean }): void {
    this.sendSettlement.closeSession(sessionId)
    if (options.listed) {
      this.statusFeed.revokeLive(sessionId)
    } else {
      this.statusFeed.close(sessionId)
    }
    // The next open re-baselines rather than announcing the turn it was already holding.
    this.turnCompletionFeed.forget(sessionId)
  }

  closeAll(): void {
    this.stopAtRestCommandUpdates()
    this.sendSettlement.closeAll()
  }

  private publishJournal(sessionId: string, journal: AgentSessionJournal): void {
    this.statusFeed.publish(sessionId, journal)
    this.sendSettlement.publish(sessionId, journal)
    // Derived here rather than per-subscriber: this edge runs whether or not anyone is
    // subscribed, which is the whole reason a backgrounded chat can complete at all. After the
    // status publish, so it reads the projection that publish cached.
    this.turnCompletionFeed.observe(sessionId, journal)
    this.onJournalActivity(sessionId)
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
    }
    return journal
  }
}
