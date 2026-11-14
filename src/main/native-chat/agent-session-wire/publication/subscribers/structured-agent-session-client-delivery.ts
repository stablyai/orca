import { readForkMarker } from '../history/agent-session-fork-marker'
import { StructuredAgentSessionJournalObservers } from '../../observations/structured-agent-session-journal-observers'
import type { StructuredAgentSessionConversations } from '../../host/structured-agent-session-conversations'
import { StructuredAgentSessionSavedStatus } from '../../observations/structured-agent-session-saved-status'
import { createStructuredAgentSessionHostRequestFailures } from '../../observations/structured-agent-session-host-request-failures'
import {
  readStructuredAgentSessionCommands,
  readStructuredAgentSessionCommandsSettled
} from '../../options/structured-agent-session-command-reading'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import { AgentSessionRefusalError } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentChildWorkEvidence } from '../../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import type { SubscriberFieldHooks } from './agent-session-subscriber-frame-fields'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  structuredQueueSendGate,
  tryReadQueuePublication
} from '../../delivery/structured-agent-session-queued-publication'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../../host/structured-agent-session-host-types'
import '../../operations/structured-agent-session-mutation-admission'
import { AGENT_SESSION_NOT_ATTACHED } from '../../operations/structured-agent-session-mutation-refusals'
import {
  StructuredAgentSessionSendSettlement,
  sendSettlementReading
} from '../../delivery/structured-agent-session-send-settlement'
import { heldStructuredAgentSessionCurrentWork } from '../../observations/structured-agent-session-host-current-work'
import { structuredAgentSessionConversationFence } from '../../host/structured-agent-session-provider-child'
import type { StructuredAgentSessionStatusFeed } from '../../observations/structured-agent-session-status-feed'
import type { StructuredAgentSessionStatusSubscriber as StatusSubscriber } from '../../observations/structured-agent-session-status-feed-deps'
import type { CapturedChildWorkStops } from '../../observations/structured-agent-session-status-ownership'
import { createStructuredAgentSessionHostStatusFeed } from '../../observations/structured-agent-session-host-status-feed'
import type { StructuredAgentSessionChildWorkProducer } from '../../observations/structured-agent-session-subagent-rows'
import {
  StructuredAgentSessionTurnCompletionFeed,
  type StructuredAgentSessionTurnCompletionSubscriber as TurnCompletionSubscriber
} from '../../observations/structured-agent-session-turn-completion-feed'

export class StructuredAgentSessionClientDelivery {
  readonly subscribers: AgentSessionSubscribers
  readonly waitForSendSettlement: StructuredAgentSessionSendSettlement['wait']
  private stopAtRestCommandUpdates: () => void = () => undefined
  private readonly savedStatus
  private readonly statusFeed
  private readonly turnCompletionFeed
  readonly requestFailures
  private readonly sendSettlement
  private readonly journalObservers = new StructuredAgentSessionJournalObservers(
    (sessionId, error) =>
      this.deps().logger.warn('observing a journal publication failed', {
        scope: 'journal-delivery',
        sessionId,
        error
      })
  )

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    private readonly deps: () => StructuredAgentSessionHostDeps,
    /** Wake queue on every publish; only journal activity renews idle time, not generation end. */
    private readonly queue: {
      onJournalActivity: (sessionId: string, activity?: boolean, inputChanged?: boolean) => void
    },
    onAgentStarted: (sessionId: string) => void,
    onChildWorkChanged: (sessionId: string) => void,
    // Current clients interpret an absent opening roster as no tasks.
    readBackgroundTasks: NonNullable<SubscriberFieldHooks['readBackgroundTasks']>,
    starting?: (sessionId: string) => boolean,
    private readonly publications?: Pick<
      StructuredAgentSessionConversations,
      'publish' | 'endPublications'
    >,
    readUsageLimitContinue?: (id: string) => AgentSessionStatusSummary['usageLimitContinue']
  ) {
    this.requestFailures = createStructuredAgentSessionHostRequestFailures(sessions, deps)
    this.savedStatus = new StructuredAgentSessionSavedStatus(deps)
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({
      onPublished: this.savedStatus.observe,
      sessions,
      starting,
      now,
      currentWork: (sessionId, journal) => this.currentWork(sessionId, journal),
      deps,
      onAgentStarted,
      onChildWorkChanged,
      readUsageLimitContinue
    })
    this.turnCompletionFeed = new StructuredAgentSessionTurnCompletionFeed({
      sessions,
      now,
      readStatusState: (sessionId, journal) =>
        this.statusFeed.journalProjection(sessionId, journal)?.state ?? null,
      readChildWork: (sessionId) => this.statusFeed.readChildWork(sessionId)
    })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.settlementReading(sessionId, this.requireJournal(sessionId))
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readForkJournal: (id) => this.sessions.get(id)?.journal,
      readForkMarker: (sessionId) => readForkMarker(this.deps().store, sessionId),
      readCommands: (sessionId, commandsOnRequest) =>
        this.readCommands(sessionId, commandsOnRequest),
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

  watchAtRestCommands(adapter: StructuredAgentSessionHostDeps['adapter']): void {
    this.stopAtRestCommandUpdates =
      adapter.atRestCommands?.onChange((change) =>
        this.subscribers.republishCommands(
          change
            ? (sessionId) => {
                const record = this.deps().store.getRecord(sessionId)
                return record != null && change.retired(record)
              }
            : undefined
        )
      ) ?? (() => undefined)
  }

  readCommands = (sessionId: string, commandsOnRequest = false) =>
    readStructuredAgentSessionCommands(this.deps(), sessionId, commandsOnRequest)

  readCommandsSettled = (sessionId: string, commandsOnRequest = false) =>
    readStructuredAgentSessionCommandsSettled(this.deps(), sessionId, commandsOnRequest)

  readUsageLimitCut = (id: string) => this.statusFeed.journalProjection(id)?.usageLimitCut ?? null

  drainStatusWrites = (): Promise<void> => this.savedStatus.drain()

  publishSavedStatusGroup = (
    visit: Parameters<StructuredAgentSessionStatusFeed['publishSavedGroup']>[0]
  ): void => this.statusFeed.publishSavedGroup(visit)

  publishStatus = (sessionId: string): void => this.statusFeed.publish(sessionId)

  publishConversationName = (sessionId: string): void =>
    this.statusFeed.publishConversationName(sessionId)

  publishRecordNotes = (sessionId: string): void => this.statusFeed.publishRecordNotes(sessionId)

  publishChildWork = (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): void => {
    this.statusFeed.publishChildWork(sessionId, evidence, producer)
    // A drain can be the moment a held turn becomes finished.
    this.turnCompletionFeed.observe(sessionId)
  }

  readStopping = (sessionId: string): boolean => {
    const projection = this.statusFeed.journalProjection(sessionId)
    return projection?.stopping === true && projection.state.summary.status === 'working'
  }

  readChildWork = (sessionId: string): AgentChildWorkView[] | undefined =>
    this.statusFeed.readChildWork(sessionId)

  childWorkOpen = (sessionId: string): boolean => this.statusFeed.childWorkOpen(sessionId)
  childWorkAutonomous = (sessionId: string): boolean =>
    this.statusFeed.childWorkAutonomous(sessionId)

  captureChildWorkStops = (
    sessionId: string,
    handleIds: readonly string[]
  ): CapturedChildWorkStops => this.statusFeed.captureChildWorkStops(sessionId, handleIds)

  childWorkIncomplete = (sessionId: string): boolean =>
    this.statusFeed.childWorkIncomplete(sessionId)

  publishStatusAndSettlement = (sessionId: string): void => {
    this.publications?.publish(sessionId, 'operational')
    this.statusFeed.publish(sessionId)
    const journal = this.sessions.get(sessionId)?.journal
    if (journal) {
      this.sendSettlement.publish(sessionId, this.settlementReading(sessionId, journal))
      this.queue.onJournalActivity(sessionId, false)
    }
  }

  /** Publish generation-end evidence even without cleanup rows; wake queue without renewing idle time.
   * restate rebaselines readers after fence movement. */
  publishGenerationEnded = (sessionId: string, options: { restate?: boolean } = {}): void => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    try {
      this.requestFailures.generationEnded(sessionId)
    } catch (error) {
      this.deps().logger.warn('observing a request death failed', {
        scope: 'request-outcomes',
        sessionId,
        error
      })
    }
    // Invalidate cached work before every reader re-derives.
    session.operationalRevision = (session.operationalRevision ?? 0) + 1
    const { journal } = session
    this.publications?.publish(sessionId, 'operational')
    if (options.restate) {
      const fence = structuredAgentSessionConversationFence(this.deps().store, sessionId)
      this.subscribers.snapshot(sessionId, journal, fence)
      return
    }
    this.subscribers.deliverFrames(sessionId, journal)
    this.publishJournal(sessionId, journal, false)
  }

  readCurrentWork = (sessionId: string) => {
    const journal = this.sessions.get(sessionId)?.journal
    return journal ? this.currentWork(sessionId, journal) : null
  }

  publishRestored = (sessionId: string): void => {
    this.publications?.publish(sessionId, 'reset')
    this.statusFeed.publish(sessionId, undefined, { replay: true })
    this.turnCompletionFeed.observe(sessionId, undefined, { historical: true })
  }

  /** Observe every journal publication, including row-free wakes, without opening a client stream.
   *  `seed` reads the journal as it is now, so an observer comparing publications has a baseline. */
  observeJournalPublications = (
    sessionId: string,
    observer: (journal: AgentSessionJournal) => void,
    seed?: (journal: AgentSessionJournal | undefined) => void
  ): (() => void) => {
    const unsubscribe = this.journalObservers.add(sessionId, observer)
    seed?.(this.sessions.get(sessionId)?.journal)
    return unsubscribe
  }

  subscribeStatus = (subscriber: StatusSubscriber) => this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => this.statusFeed.forget(sessionId)

  readStatusSummary = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.statusFeed.readPublished(sessionId)

  subscribeTurnCompletions = (subscriber: TurnCompletionSubscriber): (() => void) =>
    this.turnCompletionFeed.subscribe(subscriber)

  /** Closing handles retains session-list rows; agent-status retains them only while tabs need them. */
  closeSession(sessionId: string, options: { listed: boolean }): void {
    this.publications?.publish(sessionId, 'detach')
    this.requestFailures.forget(sessionId)
    this.sendSettlement.closeSession(sessionId)
    if (options.listed) {
      this.statusFeed.revokeLive(sessionId)
    } else {
      this.statusFeed.close(sessionId)
    }
    // Reopen rebaselines instead of reannouncing the prior turn.
    this.turnCompletionFeed.forget(sessionId)
  }

  async closeAll(): Promise<void> {
    this.publications?.endPublications()
    await this.drainStatusWrites()
    this.requestFailures.clear()
    this.stopAtRestCommandUpdates()
    this.sendSettlement.closeAll()
    this.journalObservers.clear()
  }

  publishJournal(
    sessionId: string,
    journal: AgentSessionJournal,
    activity = true,
    inputChanged = true
  ): void {
    this.statusFeed.publish(sessionId, journal)
    this.sendSettlement.publish(sessionId, this.settlementReading(sessionId, journal))
    // Observe completion after status projection updates, even without subscribers for background chats.
    this.turnCompletionFeed.observe(sessionId, journal)
    this.queue.onJournalActivity(sessionId, activity, inputChanged)
    this.journalObservers.publish(sessionId, journal)
  }

  private currentWork(sessionId: string, journal: AgentSessionJournal) {
    const session = this.sessions.get(sessionId)
    return heldStructuredAgentSessionCurrentWork(this.deps().store, sessionId, journal, session)
  }

  private settlementReading(sessionId: string, journal: AgentSessionJournal) {
    return sendSettlementReading(journal, () => this.currentWork(sessionId, journal))
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
    }
    return journal
  }
}
