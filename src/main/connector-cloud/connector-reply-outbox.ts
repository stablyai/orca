// The reply outbox's sender (design item 125 §3): filled, unsent rows go to the cloud as reply events
// under a hello that lists replies.outbox, else through /replies (the kill switch); a row is marked
// sent only once the cloud accepted it.
import { createHash } from 'node:crypto'
import {
  CONNECTOR_CLIENT_LIMITS,
  cloudConversation,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyOutcome,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorReplyBody } from './connector-replies'

export type ConnectorReplyJournal = {
  read(sessionId?: string): Promise<JournalConnectorReplyRow[]>
  fillOutcomes(fills: readonly JournalConnectorReplyFill[]): Promise<boolean>
  sent(keys: readonly JournalConnectorReplyKey[]): Promise<void>
}

export type ConnectorReplyEvent = Extract<ConnectorEvent, { kind: 'reply' }>

/** The running client's way to send, and whether its hello takes the outbox. */
export type ConnectorReplyRoute = {
  client: ConnectorReplyClient | null
  outbox: boolean | undefined
}

/** How the running client sends what the journal holds; null while none runs. */
export type ConnectorReplyClient = {
  /** Under a hello that lists replies.outbox: hands events to the events transport. */
  push: (events: ConnectorReplyEvent[]) => void
  /** Under one that doesn't: one /replies post. */
  post: (body: ConnectorReplyBody) => Promise<ConnectorResult<unknown>>
  hostName: () => string
}

const RETRY_MS = 30_000

export const isReplyEvent = (event: ConnectorEvent): event is ConnectorReplyEvent =>
  event.kind === 'reply'

/** The kill-switch drain's reply id: stable per delivery, so its post id is idempotent. */
export function drainReplyId(deliveryId: string): string {
  return `outcome-${createHash('sha256').update(deliveryId).digest('base64url')}`
}

/** What the thread reads for an outcome with no prose (design §5). */
export function outcomeSentence(outcome: JournalConnectorReplyOutcome, hostName: string): string {
  switch (outcome) {
    case 'answered':
    case 'quiet':
    case 'no_answer':
      return `Done on ${hostName}, without a written answer.`
    case 'interrupted':
    case 'failed':
      return `The agent on ${hostName} stopped before it answered. Send again to retry.`
    case 'cancelled':
    case 'withdrawn':
      return `Stopped on ${hostName}.`
    case 'cleared':
      return 'The chat was cleared in Orca before this was answered. Ask again.'
    case 'not_found':
      return `Orca on ${hostName} no longer has this request. Ask again.`
    case 'unattributed':
      return `Done on ${hostName}, answered together with the earlier messages.`
  }
}

type Filled = JournalConnectorReplyRow & { fill: NonNullable<JournalConnectorReplyRow['fill']> }

/** One event per conversation and answer, at most the contract's ids each. */
export function replyEventsOf(rows: readonly Filled[]): ConnectorReplyEvent[] {
  const groups = new Map<string, Filled[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.conversation, row.fill.answerDeliveryId, row.fill.outcome])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const events: ConnectorReplyEvent[] = []
  for (const group of groups.values()) {
    const [first] = group
    const conversation = first && cloudConversation(first.conversation)
    if (!first || !conversation) {
      continue
    }
    const { answerDeliveryId, outcome, prose, failure, links } = first.fill
    // Each event names the answer's own delivery among its ids.
    const others = group.map((row) => row.deliveryId).filter((id) => id !== answerDeliveryId)
    const room = CONNECTOR_CLIENT_LIMITS.maxReplyDeliveryIds - 1
    for (let start = 0; start === 0 || start < others.length; start += room) {
      events.push({
        kind: 'reply',
        conversation,
        deliveryIds: [answerDeliveryId, ...others.slice(start, start + room)],
        answerDeliveryId,
        outcome,
        ...(outcome === 'answered' && prose ? { prose } : {}),
        ...(failure ? { failure } : {}),
        ...(links?.length ? { links } : {})
      })
    }
  }
  return events
}

/**
 * One account's filled, unsent rows on their way to the cloud. A row handed to the events transport
 * stays in flight until the cloud accepts its event or the transport lets it go.
 */
export class ConnectorReplyOutbox {
  private readonly inFlight = new Set<string>()
  // Filled rows the last read found and nothing has sent yet: a cold start's reason to connect.
  private waiting = 0
  private running: Promise<void> | null = null
  private again = false
  private retired = false
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly account: string,
    // Null while no journal is open.
    private readonly journal: () => ConnectorReplyJournal | null,
    private readonly hooks: {
      /** Whether anything waits changed. */
      owed: () => void
      /** A failed post's backoff ran out: drain again with whatever client runs now. */
      wake: () => void
      /** The running client and its hello's capability as they are now: read at each send. A null
       *  client (none runs) or an undefined capability (no hello yet) only counts the rows. */
      route: () => ConnectorReplyRoute
    }
  ) {}

  get owed(): number {
    return this.waiting
  }

  /** Events the transport no longer holds go again on the next drain. */
  forget(events: readonly ConnectorEvent[]): void {
    for (const event of events.filter(isReplyEvent)) {
      event.deliveryIds.forEach((id) => this.inFlight.delete(id))
    }
  }

  /** The cloud accepted these events: their rows are sent. */
  async accepted(events: readonly ConnectorEvent[]): Promise<void> {
    const ids = events.filter(isReplyEvent).flatMap((event) => event.deliveryIds)
    const journal = this.journal()
    if (ids.length === 0 || !journal) {
      return
    }
    await journal
      .sent(ids.map((deliveryId) => ({ account: this.account, deliveryId })))
      .catch((error: unknown) => console.warn('[connector] could not mark replies sent', error))
    this.forget(events)
  }

  /** Signed out or another account: nothing of this one's goes anywhere again. */
  retire(): void {
    this.retired = true
    this.inFlight.clear()
    this.stopRetry()
  }

  /** Sends what the journal holds the way the current hello takes it. A call while one runs makes
   *  it read again once done, so no wake is lost. */
  drain(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.drainOnce()
      } while (this.again && !this.retired)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drainOnce(): Promise<void> {
    const journal = this.journal()
    if (!journal || this.retired) {
      return
    }
    const rows = await journal.read().catch((): JournalConnectorReplyRow[] => [])
    if (this.retired) {
      return
    }
    const owed = rows.filter(
      (row): row is Filled =>
        row.account === this.account && row.fill !== undefined && !this.inFlight.has(row.deliveryId)
    )
    this.setWaiting(owed.length)
    // The hello and client as they are now, after the read; and the account still this one, after
    // a count that may have reconciled it away.
    const { client, outbox } = this.hooks.route()
    if (this.retired || !client || outbox === undefined || owed.length === 0) {
      return
    }
    if (outbox) {
      owed.forEach((row) => this.inFlight.add(row.deliveryId))
      client.push(replyEventsOf(owed))
      this.setWaiting(0)
      return
    }
    await this.post(journal, owed)
  }

  /** The kill switch: each row through /replies, its answer's key shared by the group. A row the
   *  cloud didn't take stays for a later drain; the rest go on. */
  private async post(journal: ConnectorReplyJournal, owed: readonly Filled[]): Promise<void> {
    let left = owed.length
    for (const row of owed) {
      const { outcome, prose, answerDeliveryId, filledAt } = row.fill
      const conversation = cloudConversation(row.conversation)
      if (outcome !== 'quiet' && conversation) {
        // Checked just before the wire: still this account, still the kill switch's hello.
        const { client, outbox } = this.hooks.route()
        if (this.retired || !client || outbox !== false) {
          this.again ||= outbox === true
          return
        }
        const posted = await client.post({
          replyId: drainReplyId(row.deliveryId),
          conversation,
          turnId: filledAt,
          text:
            outcome === 'answered' && prose ? prose : outcomeSentence(outcome, client.hostName()),
          answerDeliveryId
        })
        if (this.retired) {
          return
        }
        if (!posted.ok) {
          this.scheduleRetry()
          continue
        }
      }
      await journal.sent([{ account: this.account, deliveryId: row.deliveryId }])
      if (this.retired) {
        return
      }
      this.setWaiting((left -= 1))
    }
  }

  /** A row set aside for now: a drain after the usual wait hands it over again. */
  retryLater(): void {
    if (!this.retired) {
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    this.stopRetry()
    this.retry = setTimeout(() => {
      this.retry = null
      this.hooks.wake()
    }, RETRY_MS)
    this.retry.unref?.()
  }

  private stopRetry(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
  }

  private setWaiting(count: number): void {
    const was = this.waiting
    this.waiting = count
    if ((was === 0) !== (count === 0)) {
      this.hooks.owed()
    }
  }
}
