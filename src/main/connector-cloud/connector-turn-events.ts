// The seam's watch, as the cloud reads it. Turn ends wait in an owner-only file so a restart still reports them.
import { join } from 'node:path'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_AUDIENCE_EVENTS_VERSION,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import { SIGNED_OUT, type ConnectorFailure } from './connector-cloud-request'
import { ConnectorOutbox, type ConnectorOutboxHead, type ConnectorStamp } from './connector-outbox'
import { ConnectorTurnEndFile } from './connector-turn-outbox-file'
import { connectorSnapshot, jsonBytes } from './connector-snapshot'
import {
  ConnectorSnapshotTrace,
  type ConnectorSnapshotExpectation
} from './connector-snapshot-trace'
import { ConnectorPromptPublications } from './connector-prompt-publications'
import { answerFor, answerTextFor, toConnectorEvent } from './connector-event-wire'
import { slackReplyBody } from './connector-slack-text'
import type { ConnectorCallObserver } from './connector-transport'
import {
  ConnectorReplyOutbox,
  isReplyEvent,
  type ConnectorReplyClient,
  type ConnectorReplyJournal,
  type ConnectorReplyRoute
} from './connector-reply-outbox'

const TURN_OUTBOX_FILE = 'connector-turn-outbox.json'
const MAX_TURN_ENDS = 200
// Live events past this are dropped oldest first; a fresh hello and snapshot then restate them.
const MAX_LIVE_EVENTS = 500
// Room for the request's own fields around its events.
const EVENTS_BUDGET_BYTES = CONNECTOR_CLIENT_LIMITS.maxRequestBytes - 1024

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

/** The reply outbox's journal, the kill switch's /replies post, and a cold start's wake. */
export type ConnectorTurnEventsReplies = Pick<ConnectorReplyClient, 'post' | 'hostName'> & {
  journal: () => ConnectorReplyJournal | null
  /** Whether anything is owed changed, e.g. a cold start's filled rows. */
  onOwed: () => void
}

const NO_REPLIES: ConnectorTurnEventsReplies = {
  journal: () => null,
  onOwed: () => {},
  post: async () => SIGNED_OUT,
  hostName: () => ''
}

const isTurnEnded = (event: ConnectorEvent): event is TurnEnded => event.kind === 'turn-ended'
// Reply events are the journal's rows in transit: never trimmed, never stored here.
const isLive = (event: ConnectorEvent): boolean =>
  event.kind !== 'turn-ended' && event.kind !== 'snapshot' && event.kind !== 'reply'

export { capUtf8 } from './connector-snapshot'

/** As many leading events as fit in one request, and at least one. */
function eventsHeadSize(events: readonly ConnectorEvent[]): number {
  let bytes = 0
  for (const [index, event] of events.entries()) {
    bytes += jsonBytes(event) + 1
    if (bytes > EVENTS_BUDGET_BYTES) {
      return Math.max(1, index)
    }
  }
  return events.length
}

/** Only a pane's newest unsent activity is worth sending: each one replaces the last in the thread. */
function newestActivities(events: ConnectorEvent[], sent: number): ConnectorEvent[] {
  const newest = new Map<string, number>()
  events.forEach((event, index) => {
    if (event.kind === 'activity') {
      newest.set(event.paneKey, index)
    }
  })
  return newest.size === 0
    ? events
    : events.filter(
        (event, index) =>
          index < sent || event.kind !== 'activity' || newest.get(event.paneKey) === index
      )
}

/**
 * Keeps the newest turn ends and live events within their caps, never trimming the first `sent`, so memory
 * and disk hold the same set. A snapshot is never dropped: it opens its hello.
 */
function boundEvents(events: ConnectorEvent[], sent: number): ConnectorEvent[] {
  let turnEndsOver = events.filter(isTurnEnded).length - MAX_TURN_ENDS
  let liveOver = events.filter(isLive).length - MAX_LIVE_EVENTS
  if (turnEndsOver <= 0 && liveOver <= 0) {
    return events
  }
  return events.filter(
    (event, index) =>
      index < sent || (isTurnEnded(event) ? turnEndsOver-- <= 0 : !isLive(event) || liveOver-- <= 0)
  )
}

/**
 * One account's events for the cloud, in order, owned once per process so a replacement client never
 * races a retired one over the file. Turn ends also wait on disk until the cloud accepts them.
 */
export class ConnectorTurnEvents {
  private readonly outbox: ConnectorOutbox<ConnectorEvent>
  private readonly stored: ConnectorTurnEndFile
  // Something owed was dropped to stay within the caps; only a fresh snapshot restates it.
  private readonly publications = new ConnectorPromptPublications()
  private dropped = false
  private warnedTrimmed = false
  // From the current hello's answer; empty before one.
  private cloudFeatures: ReadonlySet<string> = new Set()
  private readonly requestVersions = new Map<number, 1 | 2>()
  private readonly replies: ConnectorReplyOutbox
  // Flushes the running client's events; null while none runs.
  private replyFlush: (() => void) | null = null
  // Whether the current hello's answer listed replies.outbox; undefined before one.
  private repliesOutbox: boolean | undefined

  constructor(
    userDataPath: string,
    readonly account: string,
    private readonly trace = new ConnectorSnapshotTrace(),
    private readonly replyDeps: ConnectorTurnEventsReplies = NO_REPLIES
  ) {
    this.stored = new ConnectorTurnEndFile(join(userDataPath, TURN_OUTBOX_FILE), account)
    this.replies = new ConnectorReplyOutbox(account, replyDeps.journal, {
      owed: replyDeps.onOwed,
      wake: () => void this.drainReplies(),
      route: () => this.replyRoute()
    })
    this.outbox = new ConnectorOutbox<ConnectorEvent>({
      headSize: eventsHeadSize,
      initial: this.stored.read(),
      bound: (queued, sent) => {
        // A superseded activity is no loss, so it owes no snapshot.
        const events = newestActivities(queued, sent)
        const kept = boundEvents(events, sent)
        this.dropped ||= kept.length < events.length
        return kept
      },
      // Only a change to the turn ends touches the disk.
      onChange: (events) => this.stored.save(events.filter(isTurnEnded)),
      onStamped: (batch, stamp) => this.trace.stamped(batch, stamp),
      onAccepted: (batch, stamp) => {
        this.trace.accepted(batch, stamp)
        void this.replies.accepted(batch)
      },
      onSplit: (batch) => this.trace.split(batch),
      onDropped: (item, stamp, failure) => {
        this.trace.dropped(item, stamp)
        // A reply refused as invalid can't succeed as sent: it stays in flight, so this process
        // never resends it (its row stays unsent). Any other refusal (a 503 outcome that doesn't
        // stand yet) goes again later.
        if (failure?.status === 400) {
          return
        }
        this.replies.forget([item])
        this.replies.retryLater()
      }
    })
  }

  /** Why the next watch's snapshot is taken, said just before that watch. */
  expectSnapshot(expectation: ConnectorSnapshotExpectation): void {
    this.trace.expect(expectation)
  }

  /** Watches an events request carrying a snapshot, for its trace; undefined for any other. */
  requestsFor(batch: readonly ConnectorEvent[]): ConnectorCallObserver | undefined {
    const trace = this.trace.requestsFor(batch)
    const publications = this.publications.requestsFor(batch)
    if (!trace && !publications) {
      return undefined
    }
    return {
      callStarted: () => trace?.callStarted(),
      callSettled: () => trace?.callSettled(),
      requestStarted: (renewal) => {
        trace?.requestStarted(renewal)
        publications?.started()
      },
      requestSettled: (status) => {
        publications?.settled(status)
        trace?.requestSettled(status)
      },
      noRequest: (reason) => trace?.noRequest(reason)
    }
  }

  /** Set before the hello's watch starts, so its events match what that cloud reads. */
  useCloudFeatures(features: ReadonlySet<string>, helloRev?: number): void {
    this.cloudFeatures = features
    // Under a hello without it (the kill switch), this hello's snapshot lets replies in transit go,
    // and they drain through /replies instead.
    this.repliesOutbox = features.has(CONNECTOR_REPLIES_OUTBOX_FEATURE)
    if (helloRev !== undefined && !this.requestVersions.has(helloRev)) {
      this.requestVersions.set(
        helloRev,
        features.has(CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE)
          ? CONNECTOR_AUDIENCE_EVENTS_VERSION
          : 1
      )
      if (this.requestVersions.size > 2) {
        const oldest = this.requestVersions.keys().next().value
        if (oldest !== undefined) {
          this.requestVersions.delete(oldest)
        }
      }
    }
  }

  /** A hello's stamped version never downgrades a retained audience batch. */
  requestVersion(helloRev: number): 1 | 2 {
    return this.requestVersions.get(helloRev) ?? CONNECTOR_AUDIENCE_EVENTS_VERSION
  }

  resetLive(): void {
    this.restart([], this.carried)
    this.dropped = true
  }

  /** Events not yet accepted by the cloud, and filled replies not yet handed to it. */
  get owed(): number {
    return this.outbox.size + this.replies.owed
  }

  /** The running client's flush, or null once it stops. */
  useReplyFlush(flush: (() => void) | null): void {
    this.replyFlush = flush
  }

  /** The account whose outbox admits deliveries under the current hello; null for the legacy way. */
  replyAccount(): string | null {
    return this.repliesOutbox ? this.account : null
  }

  /** Sends the journal's filled, unsent replies the way the current hello takes them. */
  drainReplies(): Promise<void> {
    return this.replies.drain()
  }

  private replyRoute(): ConnectorReplyRoute {
    const flush = this.replyFlush
    const { post, hostName } = this.replyDeps
    return {
      client: flush && {
        // As the events path sends it: within the older cap for a cloud without answers.long.
        post: (reply) => {
          const shown = slackReplyBody(reply)
          return post({ ...shown, text: answerTextFor(shown.text, this.cloudFeatures) })
        },
        hostName,
        push: (events) => {
          this.outbox.push(...events)
          flush()
        }
      },
      outbox: this.repliesOutbox
    }
  }

  // Across a new hello: turn ends, and replies while the cloud still takes them.
  private readonly carried = (event: ConnectorEvent): boolean =>
    isTurnEnded(event) || (isReplyEvent(event) && this.repliesOutbox === true)

  private restart(first: ConnectorEvent[], keep: (event: ConnectorEvent) => boolean): void {
    let released: ConnectorEvent[] = []
    this.outbox.restart(first, (event) => {
      const kept = keep(event)
      if (!kept) {
        released = [...released, event]
      }
      return kept
    })
    this.replies.forget(released)
  }

  /** True until the next snapshot once the caps dropped an event. */
  get needsSnapshot(): boolean {
    return this.dropped
  }

  /**
   * A snapshot opens a hello's events: it goes first, numbered 0, and replaces every live event still
   * owed; only turn ends carry over. Everything else follows in order.
   */
  observe(event: ConversationSnapshot | ConversationEvent): void {
    if (event.kind === 'snapshot') {
      const built = connectorSnapshot(event, Date.now(), this.cloudFeatures)
      if (built.trimmed && !this.warnedTrimmed) {
        this.warnedTrimmed = true
        console.warn('[connector] a snapshot left out some active conversations to fit its caps')
      }
      this.dropped = false
      this.publications.bind(event, built.snapshot)
      this.trace.built(event, built)
      this.restart([built.snapshot], this.carried)
      return
    }
    const wire = toConnectorEvent(event, this.cloudFeatures)
    if (event.kind === 'turn-ended' && event.turnId === null) {
      // Its start predates the watch, so the cloud can't place it and nothing posts.
      console.info('[connector] turn end without its start left out', {
        hadReply: Boolean(event.lastAssistantMessage),
        stopReason: event.stopReason
      })
    }
    if (wire) {
      this.publications.bind(event, wire)
      this.outbox.push(wire)
    }
  }

  next(helloRev: number): ConnectorOutboxHead<ConnectorEvent> | null {
    const head = this.outbox.next(helloRev)
    return (
      head && { ...head, batch: head.batch.map((event) => answerFor(event, this.cloudFeatures)) }
    )
  }

  accepted(stamp: ConnectorStamp): void {
    this.outbox.accepted(stamp)
  }

  refused(stamp: ConnectorStamp, failure?: ConnectorFailure): ConnectorEvent | null {
    return this.outbox.refused(stamp, failure)
  }

  /** Drops everything, file included: no other account can report these turns. */
  clear(): void {
    this.stored.clear()
    this.replies.retire()
    this.outbox.restart([], () => false)
    this.trace.flush()
  }

  /** The same, before any owner exists in this process. */
  static clearStored(userDataPath: string): void {
    ConnectorTurnEndFile.clearAt(join(userDataPath, TURN_OUTBOX_FILE))
  }

  /** Every queued save of pending turn ends, landed; for quit. */
  static settled(): Promise<void> {
    return ConnectorTurnEndFile.settled()
  }
}
