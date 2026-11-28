import {
  drainReplyBody,
  fitReplyProse,
  replyDeliveryIds,
  replyEventsOf,
  type ConnectorReplyEvent,
  type FilledConnectorReply as Filled
} from './connector-reply-events'
import {
  cloudConversation,
  type ConnectorEvent,
  type ConnectorFailure
} from '../../shared/connectors/connector-cloud-contract'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyCutRows,
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyRetryRows,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorReplyBody } from './connector-replies'

export type ConnectorReplyJournal = {
  read(sessionId?: string): Promise<JournalConnectorReplyRow[]>
  /** One page of an account's filled, unsent rows after a delivery id, in delivery id order. */
  readOwed(
    account: string,
    after: string | null,
    limit: number,
    includePresentations?: boolean
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
  holdForRetry(rows: JournalConnectorReplyRetryRows): Promise<boolean>
}

/** The running client's way to send, and whether its hello takes the outbox. */
export type ConnectorReplyRoute = {
  client: ConnectorReplyClient | null
  outbox: boolean | undefined
  presentations?: boolean
  setAside?: Pick<ReadonlySet<string>, 'has'>
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

export { drainReplyId } from './connector-reply-events'

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
  private awaitingPage = false
  private nextPageAfter: string | null = null
  private rescan = false
  private readonly deferred = new Set<string>()
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

  released(ids: readonly string[], retry: boolean, prepared = false): void {
    this.forget(ids)
    if (retry) {
      if (prepared || this.hooks.route().presentations) {
        ids.forEach((id) => this.deferred.add(id))
      }
      this.retryLater()
    }
    this.advancePage()
  }

  resetPages(): void {
    this.nextPageAfter = null
    this.rescan = false
  }

  /** The cloud accepted these events: their rows are sent. */
  async accepted(events: readonly ConnectorEvent[]): Promise<void> {
    const ids = replyDeliveryIds(events)
    const journal = this.journal()
    if (ids.length === 0 || !journal) {
      return
    }
    try {
      await journal.sent(ids.map((deliveryId) => ({ account: this.account, deliveryId })))
      this.forget(ids)
      this.advancePage()
    } catch (error) {
      this.forget(ids)
      console.warn('[connector] could not mark replies sent', error)
      this.retryLater()
    }
  }

  private advancePage(): void {
    if (this.awaitingPage && this.inFlight.size === 0) {
      this.awaitingPage = false
      void this.drain()
    }
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
    const route = this.hooks.route()
    const boundedEvents =
      route.outbox && (route.presentations || this.nextPageAfter !== null || this.deferred.size > 0)
    if (boundedEvents && this.inFlight.size > 0) {
      this.awaitingPage = true
      this.rescan = true
      return
    }
    this.awaitingPage = false
    // Page by page in delivery id order, so no backlog outgrows one read. A row a page leaves (in
    // flight, or refused) stays behind the cursor for a later drain; kept counts the refused.
    let after = boundedEvents ? this.nextPageAfter : null
    this.nextPageAfter = null
    let kept = 0
    for (;;) {
      let page: JournalConnectorReplyRow[]
      try {
        page = await journal.readOwed(this.account, after, PAGE_ROWS, true)
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
      const current = this.hooks.route()
      if (current.presentations !== route.presentations || current.outbox !== route.outbox) {
        this.resetPages()
        this.again = true
        return
      }
      after = page.at(-1)?.deliveryId ?? after
      const owed = page
        .filter(
          (row): row is Filled =>
            row.account === this.account &&
            row.fill !== undefined &&
            !this.inFlight.has(row.deliveryId) &&
            !this.deferred.has(row.deliveryId) &&
            !route.setAside?.has(row.deliveryId)
        )
        .map(fitReplyProse)
      if (owed.length > 0) {
        this.setWaiting(kept + owed.length)
        // The hello and client as they are now, after the read; and the account still this one,
        // after a count that may have reconciled it away. With no client the count is enough.
        const { client, outbox, presentations } = this.hooks.route()
        if (this.retired || !client || outbox === undefined) {
          return
        }
        if (presentations !== route.presentations || outbox !== route.outbox) {
          this.resetPages()
          this.again = true
          return
        }
        if (outbox) {
          owed.forEach((row) => this.inFlight.add(row.deliveryId))
          if (boundedEvents || owed.some((row) => row.fill.presentation)) {
            this.awaitingPage = page.length === PAGE_ROWS
            this.nextPageAfter = this.awaitingPage ? after : null
            if (!this.awaitingPage && this.rescan) {
              this.rescan = false
              this.again = true
            }
            this.setWaiting(this.awaitingPage ? 1 : 0)
            client.push(replyEventsOf(owed))
            return
          }
          client.push(replyEventsOf(owed))
          this.setWaiting(kept)
          if (page.length < PAGE_ROWS) {
            return
          }
          continue
        }
        const left = await this.post(journal, owed, kept)
        if (left === null) {
          return
        }
        kept += left
      }
      if (page.length < PAGE_ROWS) {
        this.setWaiting(kept)
        if (boundedEvents && after && this.rescan) {
          this.rescan = false
          this.again = true
        }
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
      const conversation = cloudConversation(row.conversation)
      if (row.fill.outcome !== 'quiet' && conversation) {
        // Checked just before the wire: still this account, still the kill switch's hello.
        const route = this.hooks.route()
        const { client, outbox, presentations } = route
        if (this.retired || !client || outbox !== false) {
          this.again ||= outbox === true
          return null
        }
        if (row.fill.presentation && !presentations) {
          this.scheduleRetry()
          continue
        }
        const posted = await client.post(drainReplyBody(row, conversation, client.hostName))
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
    if (this.retry) {
      return
    }
    this.retry = setTimeout(() => {
      this.retry = null
      this.deferred.clear()
      this.resetPages()
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
