import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import { StructuredAgentSessionSavedStatus } from './structured-agent-session-saved-status'
import { createStructuredAgentSessionHostRequestFailures } from './structured-agent-session-host-request-failures'
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
import type {
  StructuredAgentSessionStatusFeed,
  StructuredAgentSessionStatusSubscriber
} from './structured-agent-session-status-feed'
import type { CapturedChildWorkStops } from './structured-agent-session-status-ownership'
import { createStructuredAgentSessionHostStatusFeed } from './structured-agent-session-host-status-feed'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import {
  StructuredAgentSessionTurnCompletionFeed,
  type StructuredAgentSessionTurnCompletionSubscriber
} from './structured-agent-session-turn-completion-feed'

export class StructuredAgentSessionClientDelivery {
  readonly subscribers: AgentSessionSubscribers
  readonly waitForSendSettlement: StructuredAgentSessionSendSettlement['wait']
  private stopAtRestCommandUpdates: () => void = () => undefined
  private readonly savedStatus
  private readonly statusFeed
  private readonly turnCompletionFeed
  readonly requestFailures
  private readonly sendSettlement
  private readonly journalObservers = new Map<string, Set<() => void>>()

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    private readonly deps: () => StructuredAgentSessionHostDeps,
    /** Wake queue on every publish; only journal activity renews idle time, not generation end. */
    private readonly queue: {
      onJournalActivity: (sessionId: string, activity?: boolean) => void
    },
    onAgentStarted: (sessionId: string) => void,
    onChildWorkChanged: (sessionId: string) => void,
    // Current clients interpret an absent opening roster as no tasks.
    readBackgroundTasks: NonNullable<SubscriberFieldHooks['readBackgroundTasks']>,
    starting?: (sessionId: string) => boolean,
    private readonly publications?: Pick<
      StructuredAgentSessionConversations,
      'publish' | 'endPublications'
    >
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

  readCommands(sessionId: string, commandsOnRequest = false) {
    const { adapter, store } = this.deps()
    const live = adapter.readCommands?.(sessionId)
    if (live !== undefined) {
      return live
    }
    const record = store.getRecord(sessionId)
    return record
      ? commandsOnRequest
        ? adapter.atRestCommands?.snapshot?.(record).commands
        : adapter.atRestCommands?.read(record)
      : undefined
  }

  /** Wait briefly for scans because one-shot menu readers do not receive later updates. */
  async readCommandsSettled(sessionId: string, commandsOnRequest = false) {
    const { adapter, store } = this.deps()
    const live = adapter.readCommands?.(sessionId)
    const record = store.getRecord(sessionId)
    if (live !== undefined || !record) {
      return { commands: live, ...(commandsOnRequest ? { commandsPending: false } : {}) }
    }
    const commands = adapter.atRestCommands?.settled
      ? await adapter.atRestCommands.settled(
          record,
          AT_REST_COMMANDS_READ_BUDGET_MS,
          commandsOnRequest
        )
      : adapter.atRestCommands?.read(record)
    const current = adapter.readCommands?.(sessionId)
    const snapshot = commandsOnRequest ? adapter.atRestCommands?.snapshot?.(record) : undefined
    if (current === undefined && snapshot?.retryableFailure) {
      throw new Error('Command discovery unavailable')
    }
    return {
      commands: current ?? (snapshot ? snapshot.commands : commands),
      ...(commandsOnRequest
        ? {
            commandsPending: current === undefined && (snapshot?.commandsPending ?? false)
          }
        : {})
    }
  }

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
  ): void => this.statusFeed.publishChildWork(sessionId, evidence, producer)

  readStopping = (sessionId: string): boolean => {
    const projection = this.statusFeed.journalProjection(sessionId)
    return projection?.stopping === true && projection.state.summary.status === 'working'
  }

  readChildWork = (sessionId: string): AgentChildWorkView[] | undefined =>
    this.statusFeed.readChildWork(sessionId)

  childWorkOpen = (sessionId: string): boolean => this.statusFeed.childWorkOpen(sessionId)

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

  /** Observe every journal publication, including row-free wakes, without opening a client stream. */
  observeJournalPublications = (sessionId: string, observer: () => void): (() => void) => {
    const observers = this.journalObservers.get(sessionId) ?? new Set<() => void>()
    observers.add(observer)
    this.journalObservers.set(sessionId, observers)
    return () => {
      observers.delete(observer)
      if (observers.size === 0 && this.journalObservers.get(sessionId) === observers) {
        this.journalObservers.delete(sessionId)
      }
    }
  }

  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.statusFeed.subscribe(subscriber)
  forgetStatus = (sessionId: string): void => this.statusFeed.forget(sessionId)

  readStatusSummary = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.statusFeed.readPublished(sessionId)

  subscribeTurnCompletions = (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ): (() => void) => this.turnCompletionFeed.subscribe(subscriber)

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

  private publishJournal(sessionId: string, journal: AgentSessionJournal, activity = true): void {
    this.statusFeed.publish(sessionId, journal)
    this.sendSettlement.publish(sessionId, this.settlementReading(sessionId, journal))
    // Observe completion after status projection updates, even without subscribers for background chats.
    this.turnCompletionFeed.observe(sessionId, journal)
    this.queue.onJournalActivity(sessionId, activity)
    for (const observer of this.journalObservers.get(sessionId) ?? []) {
      try {
        observer()
      } catch (error) {
        this.deps().logger.warn('observing a journal publication failed', {
          scope: 'journal-delivery',
          sessionId,
          error
        })
      }
    }
  }

  private currentWork(sessionId: string, journal: AgentSessionJournal) {
    const session = this.sessions.get(sessionId)
    return heldStructuredAgentSessionCurrentWork(this.deps().store, sessionId, journal, session)
  }

  private settlementReading(sessionId: string, journal: AgentSessionJournal) {
    return {
      // Released unanswered sends must end acknowledgement waits as uncertain.
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
