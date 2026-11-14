import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  PULL_REQUEST_EVENT_PRESENTATION,
  pullRequestEventClientMessageId,
  pullRequestEventText
} from '../../../shared/native-chat/native-chat-pull-request-event'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import {
  markPRDeliveryDelivered,
  readOldestPRPendingDelivery,
  hasPRPendingDelivery,
  readPRPendingDeliveryChatIds,
  type PRPendingDelivery
} from './pr-check-event-tables'

const PR_KEY = /^([^/]+)\/([^/]+)\/([^/#]+)#(\d+)$/u

function eventItem(delivery: PRPendingDelivery) {
  const match = PR_KEY.exec(delivery.prKey)
  if (!match) {
    return null
  }
  const [, forgeHost, owner, repo, number] = match
  const pr = { forgeHost: forgeHost!, owner: owner!, repo: repo!, number: Number(number) }
  const identity = {
    provider: 'orca' as const,
    clientMessageId: pullRequestEventClientMessageId({
      ...pr,
      headSha: delivery.headSha,
      occurrence: delivery.occurrence
    })
  }
  return {
    identity,
    itemId: agentJournalItemKey(identity),
    body: {
      kind: 'status' as const,
      presentation: PULL_REQUEST_EVENT_PRESENTATION,
      tone: delivery.verdict,
      text: pullRequestEventText(delivery.verdict, { ...pr, headSha: delivery.headSha })
    }
  }
}

/** Lines go between turns, never into one: a turn running or about to start waits for its end. */
function canAppendBetweenTurns(journal: AgentSessionJournal): boolean {
  return journal.newestTurn()?.state !== 'running' && journal.pendingSubmissions().length === 0
}

type DeliveryInput = {
  database: JournalHostDatabase
  journal: AgentSessionJournal
  sessionId: string
  /** The chat's current fence: the line is host bookkeeping in whichever generation is current. */
  fence: number
}

const draining = new Map<string, { again: boolean; done: Promise<void> }>()

/**
 * Appends a chat's pending CI lines oldest first, each in the transaction that marks it delivered.
 * One drain per chat at a time; a trigger while one runs makes it look again when it ends.
 */
export function deliverPendingPullRequestEvents(input: DeliveryInput): Promise<void> {
  const running = draining.get(input.sessionId)
  if (running) {
    running.again = true
    return running.done
  }
  const state = { again: false, done: Promise.resolve() }
  state.done = (async () => {
    try {
      do {
        state.again = false
        await drain(input)
      } while (state.again)
    } finally {
      draining.delete(input.sessionId)
    }
  })()
  draining.set(input.sessionId, state)
  return state.done
}

async function drain(input: DeliveryInput): Promise<void> {
  const { database, journal, sessionId, fence } = input
  if (database.readOnly) {
    return
  }
  for (;;) {
    if (!canAppendBetweenTurns(journal)) {
      return
    }
    const delivery = readOldestPRPendingDelivery(database.db, sessionId)
    if (!delivery) {
      return
    }
    const item = eventItem(delivery)
    const markDelivered = {
      write: (db: Database.Database) =>
        markPRDeliveryDelivered(db, sessionId, delivery.eventId, item?.itemId ?? ''),
      committed: () => {}
    }
    // An unreadable row would hold every later line back; one already written is done.
    if (!item || journal.hasRecordedItem(item.itemId)) {
      database.transaction(markDelivered.write)
      continue
    }
    await journal.appendItem(
      item.identity,
      item.body,
      { fence, turnScope: { kind: 'thread' } },
      markDelivered
    )
  }
}

/** Which chats owe lines, so a journal commit starts a drain only where it can append something. */
export class PREventDeliveryTrigger {
  private readonly owed = new Set<string>()

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      chatFence: (chatId: string) => number | null
      logger: Pick<StructuredAgentSessionLogger, 'warn'>
    }
  ) {}

  load(): void {
    for (const chatId of readPRPendingDeliveryChatIds(this.deps.database.db)) {
      this.owed.add(chatId)
    }
  }

  forget(chatId: string): void {
    this.owed.delete(chatId)
  }

  /** A new line is owed; an open chat may take it now. */
  owe(chatId: string, journal: AgentSessionJournal | null): void {
    this.owed.add(chatId)
    if (journal) {
      this.deliver(chatId, journal)
    }
  }

  /** Streaming commits during a turn cost one set lookup and a turn check, nothing more. */
  committed(chatId: string, journal: AgentSessionJournal): void {
    if (this.owed.has(chatId) && canAppendBetweenTurns(journal)) {
      this.deliver(chatId, journal)
    }
  }

  private deliver(chatId: string, journal: AgentSessionJournal): void {
    const fence = this.deps.chatFence(chatId)
    if (fence === null) {
      return
    }
    const { database } = this.deps
    void deliverPendingPullRequestEvents({ database, journal, sessionId: chatId, fence })
      .then(() => {
        // The database may be closing during shutdown; that throw is caught below too.
        if (!database.isClosed && !hasPRPendingDelivery(database.db, chatId)) {
          this.owed.delete(chatId)
        }
      })
      .catch((error: unknown) =>
        this.deps.logger.warn('appending a CI line failed', { scope: 'pr-watch', chatId, error })
      )
  }
}
