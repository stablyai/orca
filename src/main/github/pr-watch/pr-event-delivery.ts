import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  PULL_REQUEST_EVENT_PRESENTATION,
  pullRequestEventClientMessageId,
  pullRequestEventText
} from '../../../shared/native-chat/native-chat-pull-request-event'
import type { PRWatchStorage } from './pr-watch-storage'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { PRPendingDelivery } from './pr-check-event-tables'
import type { JournalWriterCommit } from '../../native-chat/agent-session-journal/journal-writer-changes'

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
async function canAppendBetweenTurns(journal: AgentSessionJournal): Promise<boolean> {
  const [turn, pending] = await Promise.all([
    journal.reads.newestTurn(),
    journal.reads.pendingSubmissions()
  ])
  return turn?.state !== 'running' && pending.length === 0
}

type DeliveryInput = {
  database: PRWatchStorage
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
    if (database.isClosed || !(await canAppendBetweenTurns(journal))) {
      return
    }
    const delivery = await database.read({ kind: 'oldest-delivery', chatId: sessionId })
    if (!delivery) {
      return
    }
    const item = eventItem(delivery)
    const operation = {
      kind: 'delivered' as const,
      chatId: sessionId,
      eventId: delivery.eventId,
      itemId: item?.itemId ?? ''
    }
    if (!item || (await journal.reads.hasRecordedItem(item.itemId))) {
      await database.write(operation)
      continue
    }
    const written = await journal.appendItem(
      item.identity,
      item.body,
      { fence, turnScope: { kind: 'thread' }, onlyBetweenTurns: true },
      {
        stage: async () => ({
          effects: [{ kind: 'pr-watch', operation }],
          settle: () => {}
        })
      }
    )
    if (!written) {
      return
    }
  }
}

/** Which chats owe lines, so a journal commit starts a drain only where it can append something. */
export class PREventDeliveryTrigger {
  private readonly owed = new Map<string, object>()

  constructor(
    private readonly deps: {
      database: PRWatchStorage
      chatFence: (chatId: string) => number | null
      logger: Pick<StructuredAgentSessionLogger, 'warn'>
    }
  ) {}

  async load(): Promise<void> {
    for (const chatId of await this.deps.database.read({ kind: 'owed-chats' })) {
      this.owed.set(chatId, {})
    }
  }

  forget(chatId: string): void {
    this.owed.delete(chatId)
  }

  /** A new line is owed; an open chat may take it now. */
  owe(chatId: string, journal: AgentSessionJournal | null): void {
    this.owed.set(chatId, {})
    if (journal) {
      this.deliver(chatId, journal)
    }
  }

  /** Streaming commits during a turn cost one set lookup and a turn check, nothing more. */
  committed(
    chatId: string,
    journal: AgentSessionJournal,
    commit: JournalWriterCommit | undefined
  ): void {
    if (
      this.owed.has(chatId) &&
      (commit?.inputChanged ||
        commit?.publication?.items.some(
          ({ body }) =>
            body.kind === 'turn' || (body.kind === 'status' && body.turnLifecycle !== undefined)
        ))
    ) {
      this.deliver(chatId, journal)
    }
  }

  private deliver(chatId: string, journal: AgentSessionJournal): void {
    const fence = this.deps.chatFence(chatId)
    if (fence === null) {
      return
    }
    const { database } = this.deps
    const token = this.owed.get(chatId)
    void deliverPendingPullRequestEvents({ database, journal, sessionId: chatId, fence })
      .then(async () => {
        // The database may be closing during shutdown; that throw is caught below too.
        if (
          !database.isClosed &&
          !(await database.read({ kind: 'has-delivery', chatId })) &&
          this.owed.get(chatId) === token
        ) {
          this.owed.delete(chatId)
        }
      })
      .catch((error: unknown) =>
        this.deps.logger.warn('appending a CI line failed', { scope: 'pr-watch', chatId, error })
      )
  }
}
