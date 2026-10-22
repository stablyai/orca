import { AT_REST_COMMANDS_READ_BUDGET_MS } from './at-rest-command-catalog'
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
import { heldStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed'
import type { CapturedChildWorkStops } from './structured-agent-session-status-ownership'
import { createStructuredAgentSessionHostStatusFeed } from './structured-agent-session-host-status-feed'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
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
    /** The queued-card drain: every publish wakes it (`activity`: a journal write, which renews the
     *  idle clock; a generation's end is not one). */
    private readonly queue: {
      onJournalActivity: (sessionId: string, activity?: boolean) => void
    },
    onAgentStarted: (sessionId: string) => void,
    /** A session's child records changed; the chat strip republishes from them. */
    onChildWorkChanged: (sessionId: string) => void,
    // Required: an opening frame without the roster reads as "no tasks" to current clients.
    readBackgroundTasks: NonNullable<SubscriberFieldHooks['readBackgroundTasks']>
  ) {
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({
      sessions,
      now,
      currentWork: (sessionId, journal) => this.currentWork(sessionId, journal),
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
      this.settlementReading(sessionId, this.requireJournal(sessionId))
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readCommands: (sessionId) => this.readCommands(sessionId),
      readQueuePublication: (sessionId) =>
        tryReadQueuePublication(
          sessions.get(sessionId)?.journal,
          structuredQueueSendGate({ store: this.deps().store, sessions }, sessionId)
        ),
      readBackgroundTasks,
      onJournalPublished: (sessionId, journal) => this.publishJournal(sessionId, journal),
      readCurrentWork: (sessionId, journal) => this.currentWork(sessionId, journal)
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

  /** As `readCommands`, but a scan this read starts or finds running gets a short while to land,
   *  for a client that asks once per menu and never hears a later change. */
  async readCommandsSettled(sessionId: string) {
    const { adapter, store } = this.deps()
    const live = adapter.readCommands?.(sessionId)
    const record = store.getRecord(sessionId)
    if (live !== undefined || !record) {
      return live
    }
    const commands = adapter.atRestCommands?.settled
      ? await adapter.atRestCommands.settled(record, AT_REST_COMMANDS_READ_BUDGET_MS)
      : adapter.atRestCommands?.read(record)
    return adapter.readCommands?.(sessionId) ?? commands
  }

  publishStatus = (sessionId: string): void => this.statusFeed.publish(sessionId)

  publishConversationName = (sessionId: string): void =>
    this.statusFeed.publishConversationName(sessionId)

  publishRecordNotes = (sessionId: string): void => this.statusFeed.publishRecordNotes(sessionId)

  publishChildWork = (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): void => this.statusFeed.publishChildWork(sessionId, evidence, producer)

  /** What the feed publishes as `stopping`: only a working session is still being stopped. */
  readStopping = (sessionId: string): boolean => {
    const projection = this.statusFeed.journalProjection(sessionId)
    return projection?.stopping === true && projection.state.summary.status === 'working'
  }

  readChildWork = (sessionId: string): AgentChildWorkView[] | undefined =>
    this.statusFeed.readChildWork(sessionId)

  /** Child work the provider reported running and not over: what every owed-work decision reads. */
  childWorkOpen = (sessionId: string): boolean => this.statusFeed.childWorkOpen(sessionId)

  captureChildWorkStops = (
    sessionId: string,
    handleIds: readonly string[]
  ): CapturedChildWorkStops => this.statusFeed.captureChildWorkStops(sessionId, handleIds)

  childWorkIncomplete = (sessionId: string): boolean =>
    this.statusFeed.childWorkIncomplete(sessionId)

  publishStatusAndSettlement = (sessionId: string): void => {
    this.statusFeed.publish(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, this.settlementReading(sessionId, journal))
    }
  }

  /** A generation ended — an exit, a release — which can change what is current with no journal
   *  row. The one edge for every way a generation ends: every reader re-derives current work (the
   *  status feed, settlement waits, each chat's frames) and the queued-card drain is scheduled,
   *  whatever became of the cleanup's own write. An end is no activity: it renews no idle clock.
   *  `restate`: each chat re-baselines at the fence, as a death of the child's own does. */
  publishGenerationEnded = (sessionId: string, options: { restate?: boolean } = {}): void => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    // What readers cache of current work is keyed on the bump, then all re-derive.
    session.operationalRevision = (session.operationalRevision ?? 0) + 1
    const { journal } = session
    if (options.restate) {
      const fence = structuredAgentSessionConversationFence(this.deps().store, sessionId)
      this.subscribers.snapshot(sessionId, journal, fence)
      return
    }
    this.subscribers.deliverFrames(sessionId, journal)
    this.publishJournal(sessionId, journal, false)
  }

  /** A held chat's current work (`structuredAgentSessionCurrentWork`); null when none is held. */
  readCurrentWork = (sessionId: string) => {
    const journal = this.sessions.get(sessionId)?.journal
    return journal ? this.currentWork(sessionId, journal) : null
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

  private publishJournal(sessionId: string, journal: AgentSessionJournal, activity = true): void {
    this.statusFeed.publish(sessionId, journal)
    this.sendSettlement.publish(sessionId, this.settlementReading(sessionId, journal))
    // Derived here rather than per-subscriber: this edge runs whether or not anyone is
    // subscribed, which is the whole reason a backgrounded chat can complete at all. After the
    // status publish, so it reads the projection that publish cached.
    this.turnCompletionFeed.observe(sessionId, journal)
    this.queue.onJournalActivity(sessionId, activity)
  }

  /** The current-work projection over this journal (`structuredAgentSessionCurrentWork`). */
  private currentWork(sessionId: string, journal: AgentSessionJournal) {
    const session = this.sessions.get(sessionId)
    return heldStructuredAgentSessionCurrentWork(this.deps().store, sessionId, journal, session)
  }

  private settlementReading(sessionId: string, journal: AgentSessionJournal) {
    return {
      // A send the child stopped holding unanswered settles the wait as doubt (`publishedSubmission`).
      submissions: () =>
        journal.submissions().map(this.currentWork(sessionId, journal).publishedSubmission),
      cursor: () => journal.cursor(),
      activeTurnId: () => this.currentWork(sessionId, journal).activeTurnId()
    }
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
    }
    return journal
  }
}
