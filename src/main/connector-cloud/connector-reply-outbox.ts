// The reply outbox's sender (design item 125 §3): filled, unsent rows go to the cloud as reply events
// under a hello that lists replies.outbox, else through /replies (the kill switch); a row is marked
// sent only once the cloud accepted it.
import { createHash } from 'node:crypto'
import {
  CONNECTOR_CLIENT_LIMITS,
  cloudConversation,
  type ConnectorEvent,
  type ConnectorFailure
} from '../../shared/connectors/connector-cloud-contract'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyCutRows,
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyOutcome,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { JOURNAL_CONNECTOR_REPLY_PROSE_BYTES } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorResult } from './connector-cloud-request'
import { capAnswer } from './connector-snapshot'
import type { ConnectorReplyBody } from './connector-replies'

export type ConnectorReplyJournal = {
  read(sessionId?: string): Promise<JournalConnectorReplyRow[]>
  /** One page of an account's filled, unsent rows after a delivery id, in delivery id order. */
  readOwed(
    account: string,
    after: string | null,
    limit: number
  ): Promise<JournalConnectorReplyRow[]>
  fillOutcomes(fills: readonly JournalConnectorReplyFill[]): Promise<boolean>
  sent(keys: readonly JournalConnectorReplyKey[]): Promise<void>
}

/** The rows' cut and claim writes (Phase 1): what restart and usage-limit recovery change. */
export type ConnectorReplyCutJournal = ConnectorReplyJournal & {
  cut(rows: JournalConnectorReplyCutRows): Promise<boolean>
  recut(
    claimMessageId: string,
    cut: JournalConnectorReplyCut,
    failure?: ConnectorFailure
  ): Promise<boolean>
  releaseClaim(claimMessageId: string): Promise<boolean>
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
// Rows one drain read takes. A row's prose comes at most just over its 32 KB cap (~66 KB
// serialized), so a page stays a small part of the reader's 64 MB reply limit.
const PAGE_ROWS = 200

export const isReplyEvent = (event: ConnectorEvent): event is ConnectorReplyEvent =>
  event.kind === 'reply'

export const replyDeliveryIds = (events: readonly ConnectorEvent[]): string[] =>
  events.filter(isReplyEvent).flatMap((event) => event.deliveryIds)

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

// A prose an older build kept whole is cut to the cap, with the note a cut answer carries, so one
// huge answer still fits its event and holds back nothing behind it.
const fitted = (row: Filled): Filled =>
  row.fill.prose === undefined
    ? row
    : {
        ...row,
        fill: { ...row.fill, prose: capAnswer(row.fill.prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) }
      }

/** One event per conversation and answer, at most the contract's ids each. */
export function replyEventsOf(rows: readonly Filled[]): ConnectorReplyEvent[] {
  const groups = new Map<string, Filled[]>()
  for (const row of rows) {
    const key = JSON.stringify([
      row.conversation,
      row.fill.answerDeliveryId,
      row.fill.outcome,
      row.fill.turnStartedAt
    ])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const events: ConnectorReplyEvent[] = []
  for (const group of groups.values()) {
    const [first] = group
    const conversation = first && cloudConversation(first.conversation)
    if (!first || !conversation) {
      continue
    }
    const { answerDeliveryId, outcome, prose, failure, links, tookMs, turnStartedAt } = first.fill
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
        ...(links?.length ? { links } : {}),
        ...(outcome === 'answered' && tookMs ? { tookMs } : {}),
        ...(turnStartedAt === undefined ? {} : { turnId: turnStartedAt })
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

  /** Replies (by delivery id) the transport no longer holds go again on the next drain. */
  forget(ids: readonly string[]): void {
    ids.forEach((id) => this.inFlight.delete(id))
  }

  /** The cloud accepted these events: their rows are sent. */
  async accepted(events: readonly ConnectorEvent[]): Promise<void> {
    const ids = replyDeliveryIds(events)
    const journal = this.journal()
    if (ids.length === 0 || !journal) {
      return
    }
    await journal
      .sent(ids.map((deliveryId) => ({ account: this.account, deliveryId })))
      .catch((error: unknown) => console.warn('[connector] could not mark replies sent', error))
    this.forget(ids)
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
    // Page by page in delivery id order, so no backlog outgrows one read. A row a page leaves (in
    // flight, or refused) stays behind the cursor for a later drain; kept counts the refused.
    let after: string | null = null
    let kept = 0
    for (;;) {
      let page: JournalConnectorReplyRow[]
      try {
        page = await journal.readOwed(this.account, after, PAGE_ROWS)
      } catch (error) {
        // A failed read isn't "nothing owed": the rows wait, and a drain after the usual wait
        // reads them again.
        console.warn('[connector] could not read the reply outbox', error)
        this.retryLater()
        return
      }
      if (this.retired) {
        return
      }
      after = page.at(-1)?.deliveryId ?? after
      const owed = page
        .filter(
          (row): row is Filled =>
            row.account === this.account &&
            row.fill !== undefined &&
            !this.inFlight.has(row.deliveryId)
        )
        .map(fitted)
      if (owed.length > 0) {
        this.setWaiting(kept + owed.length)
        // The hello and client as they are now, after the read; and the account still this one,
        // after a count that may have reconciled it away. With no client the count is enough.
        const { client, outbox } = this.hooks.route()
        if (this.retired || !client || outbox === undefined) {
          return
        }
        if (outbox) {
          owed.forEach((row) => this.inFlight.add(row.deliveryId))
          client.push(replyEventsOf(owed))
          this.setWaiting(kept)
        } else {
          const left = await this.post(journal, owed, kept)
          if (left === null) {
            return
          }
          kept += left
        }
      }
      if (page.length < PAGE_ROWS) {
        this.setWaiting(kept)
        return
      }
    }
  }

  /** The kill switch: each row through /replies, its answer's key shared by the group. A row the
   *  cloud didn't take stays for a later drain; the rest go on. How many stayed, or null once the
   *  route or account changed under it. */
  private async post(
    journal: ConnectorReplyJournal,
    owed: readonly Filled[],
    kept: number
  ): Promise<number | null> {
    let left = owed.length
    for (const row of owed) {
      const { outcome, prose, answerDeliveryId, filledAt } = row.fill
      const conversation = cloudConversation(row.conversation)
      if (outcome !== 'quiet' && conversation) {
        // Checked just before the wire: still this account, still the kill switch's hello.
        const { client, outbox } = this.hooks.route()
        if (this.retired || !client || outbox !== false) {
          this.again ||= outbox === true
          return null
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
          return null
        }
        if (!posted.ok) {
          this.scheduleRetry()
          continue
        }
      }
      await journal.sent([{ account: this.account, deliveryId: row.deliveryId }])
      if (this.retired) {
        return null
      }
      this.setWaiting(kept + (left -= 1))
    }
    return left
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
