import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { StructuredAgentSessionSendSettlement } from './structured-agent-session-send-settlement'
import {
  projectStructuredAgentSessionOwnerPage,
  structuredAgentSessionNeedsOwnerSnapshot
} from './structured-agent-session-owner-projection'
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
  private readonly ownerSnapshotCache = new WeakMap<
    AgentSessionJournal,
    {
      epoch: string
      sequence: number
      fence: number | null
      claimStatus: string | null
      required: boolean
    }
  >()

  constructor(
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    now: () => number,
    deps: () => StructuredAgentSessionHostDeps
  ) {
    this.statusFeed = createStructuredAgentSessionHostStatusFeed({ sessions, now, deps })
    this.sendSettlement = new StructuredAgentSessionSendSettlement((sessionId) =>
      this.requireJournal(sessionId)
    )
    this.waitForSendSettlement = this.sendSettlement.wait
    this.subscribers = new AgentSessionSubscribers({
      readCommands: (sessionId) => deps().adapter.readCommands?.(sessionId),
      readJournal: (sessionId) => sessions.get(sessionId)?.journal,
      needsOwnerSnapshot: (sessionId, journal) =>
        this.needsOwnerSnapshot(journal, deps().store.getRecord(sessionId)),
      projectPage: (sessionId, page) =>
        projectStructuredAgentSessionOwnerPage(page, deps().store.getRecord(sessionId)),
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
  }

  private needsOwnerSnapshot(
    journal: AgentSessionJournal,
    record: ReturnType<StructuredAgentSessionHostDeps['store']['getRecord']>
  ): boolean {
    const cursor = journal.cursor()
    const cached = this.ownerSnapshotCache.get(journal)
    const fence = record?.lease.runtimeFence ?? null
    const claimStatus = record?.lease.claimStatus ?? null
    if (
      cached?.epoch === cursor.epoch &&
      cached.sequence === cursor.sequence &&
      cached.fence === fence &&
      cached.claimStatus === claimStatus
    ) {
      return cached.required
    }
    const required = structuredAgentSessionNeedsOwnerSnapshot(journal.snapshot(), record)
    this.ownerSnapshotCache.set(journal, { ...cursor, fence, claimStatus, required })
    return required
  }

  private requireJournal(sessionId: string): AgentSessionJournal {
    const journal = this.sessions.get(sessionId)?.journal
    if (!journal) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return journal
  }
}
