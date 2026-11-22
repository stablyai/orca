// The machine side of the connector: one held poll, two confirmations per delivery, and turn events back.
import { z } from 'zod'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_PATHS,
  ConnectorPollResponse,
  type ConnectorCloudFeature,
  type ConnectorReplyResponse,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import {
  UNREADABLE_ANSWER,
  connectorStop,
  type ConnectorFailure,
  type ConnectorResult
} from './connector-cloud-request'
import { ConnectorActiveConversations } from './connector-active-conversations'
import { ConnectorDeliveryAcks } from './connector-delivery-acks'
import { connectorHelloSaid, sayConnectorHello } from './connector-hello'
import type { ConnectorPollClientOptions, ConnectorTransport } from './connector-machine'
import {
  foldConnectorReview,
  postConnectorBotMessage,
  postConnectorReply,
  type ConnectorBotPostBody,
  type ConnectorReplyBody
} from './connector-replies'
import * as pollControl from './connector-poll-control'
import { ConnectorOutboxSender } from './connector-outbox'
import { ConnectorEventRequests } from './connector-event-requests'
import { ConnectorClientSnapshots, type ConnectorClientHello } from './connector-snapshot-trace'
import { ConnectorWakePolls } from './connector-wake-channel'

// The cloud forgets a machine's running workers once it has been silent 15 minutes (its last-seen is
// a minute coarse); back from a silence near that, a fresh hello's snapshot restates them.
const HELLO_AFTER_SILENCE_MS = 10 * 60_000

export type { ConnectorPollClientOptions } from './connector-machine'

export class ConnectorPollClient {
  readonly seam: ExternalConversationSeam
  private readonly host: ExternalConversationHost
  private readonly transport: ConnectorTransport
  private readonly stopped = new AbortController()
  private readonly deliveries: ConnectorDeliveryAcks
  private readonly eventSender: ConnectorOutboxSender<ConnectorEvent>
  private readonly random: () => number
  private readonly eventRequests: ConnectorEventRequests
  // The hello the cloud took, which scopes the poll and everything sent; null until then, once the cloud
  // says it is no longer current, and once stopped. A new hello only replaces it. The cloud refuses
  // anything under another hello with 409, so a 204 always means applied.
  private helloRev: number | null = null
  // From the last hello answer; null until one arrives.
  private features: ReadonlySet<string> | null = null
  // What that hello said.
  private helloSaid = ''
  // Whether it listed the bots; one sent before the cloud said it takes pages leaves them out.
  private botsSaid = false
  // Hellos go one at a time, so a late answer never replaces a newer revision.
  private saying: Promise<ConnectorFailure | null> = Promise.resolve(null)
  private failures = 0
  private readonly respread = new pollControl.ConnectorRehelloSpread()
  // When the last answered poll went out; failed ones don't count.
  private heardAt: number | null = null
  private warnedTrimmed = false
  private stopReason: string | null = null
  // Replies and bot posts still in flight.
  private posting = 0
  private readonly active = new ConnectorActiveConversations()
  // Why each snapshot this client takes was taken, for its trace.
  private readonly snapshots = new ConnectorClientSnapshots(() => this.options.events)
  private readonly wake: ConnectorWakePolls

  get cloudFeatures(): ReadonlySet<string> | null {
    return this.features
  }

  constructor(private readonly options: ConnectorPollClientOptions) {
    this.seam = options.seam
    this.transport = options.transport
    this.random = options.random ?? Math.random
    this.host = options.machine.conversationHost()
    this.wake = new ConnectorWakePolls(options, this.random, this.stopped.signal)
    const helloRev = (): number | null => this.helloRev
    this.deliveries = new ConnectorDeliveryAcks({
      seam: this.seam,
      host: this.host,
      machine: options.machine,
      send: (acks, rev) => this.post(CONNECTOR_PATHS.acks, rev, { v: 1, helloRev: rev, acks }),
      helloRev,
      random: this.random,
      signal: this.stopped.signal,
      outbox: () => options.events.replyAccount(),
      onUnblocked: () => this.wake.requestPoll()
    })
    this.eventRequests = new ConnectorEventRequests({
      events: options.events,
      watch: (listener) => this.seam.watch(this.host, listener),
      observe: (event) => this.active.observe(event),
      flush: () => this.eventSender.flush(),
      post: (body, rev, batch) => this.post(CONNECTOR_PATHS.events, rev, body, batch),
      rejected: (rev, failure) => {
        if (this.helloRev !== rev) {
          return null
        }
        this.helloRev = null
        return this.backoff(failure)
      }
    })
    // Every hello restarts the numbering with a snapshot.
    this.eventSender = new ConnectorOutboxSender(
      options.events,
      (events, rev, seq) => this.eventRequests.post(events, rev, seq),
      helloRev,
      this.random
    )
  }

  start(): void {
    // A disable disposes the seam; nothing here may outlive it.
    this.seam.signal.addEventListener('abort', () => this.stop(), {
      once: true,
      signal: this.stopped.signal
    })
    // Turn ends that finish before the first hello still reach the outbox; only sending waits for it.
    this.watch()
    void this.run()
  }

  /**
   * Says a changed hello now rather than after the held poll, so the cloud sees a new or edited bot at once.
   * The poll stays held: the cloud refuses it under the old hello without handing it anything.
   */
  sayChanged(): void {
    // Checked once the hello in flight lands: a change during the first one is not left to the next cycle.
    const say = (): Promise<ConnectorFailure | null> =>
      this.helloRev !== null ? this.helloIfOwed() : Promise.resolve(null)
    this.saying = this.saying.then(say, say)
    // Waiting out a 409's spread with no hello: the next cycle says it now.
    this.respread.cut()
  }

  /** Posts an agent's reply to its conversation's thread while this client runs. */
  reply(body: ConnectorReplyBody): Promise<ConnectorResult<ConnectorReplyResponse>> {
    const review = this.features?.has('review' satisfies ConnectorCloudFeature)
    const sent = review ? body : foldConnectorReview(body)
    return this.posted(postConnectorReply(this.transport, sent, this.stopped.signal, this.random))
  }

  /** Posts as a bot in one of its app's channels while this client runs. */
  postAsBot(botId: string, body: ConnectorBotPostBody) {
    return this.posted(
      postConnectorBotMessage(this.transport, botId, body, this.stopped.signal, this.random)
    )
  }

  /** Resolves once the cloud took a hello from this client, once it stops, or once `signal` aborts. */
  helloTaken(signal: AbortSignal): Promise<void> {
    const taken = (): boolean => this.helloRev !== null && this.botsSaid
    return this.until(taken, AbortSignal.any([this.stopped.signal, signal]))
  }

  /** Resolves once the cloud took the current hello, no linked turn or worker runs, and nothing is owed; or once stopped. */
  settled(): Promise<void> {
    return this.until(() => this.nothingOwed(), this.stopped.signal)
  }

  private readonly until = (done: () => boolean, signal: AbortSignal): Promise<void> =>
    pollControl.waitUntil(done, () => this.saying, signal)

  private nothingOwed(): boolean {
    return (
      this.helloRev !== null &&
      JSON.stringify(connectorHelloSaid(this.options.machine, this.features)) === this.helloSaid &&
      this.deliveries.settled &&
      this.options.events.owed === 0 &&
      this.posting === 0 &&
      this.active.idle
    )
  }

  private posted<T>(post: Promise<T>): Promise<T> {
    this.posting++
    return post.finally(() => this.posting--)
  }

  stop(): void {
    this.stopped.abort()
    // Confirmations still owed are listed as unsettled after the next hello and settled from receipts.
    this.helloRev = null
    this.deliveries.stop()
    this.eventSender.stop()
    this.eventRequests.stop()
  }

  private async run(): Promise<void> {
    await this.options.machine.beforeFirstHello?.()
    while (!this.stopped.signal.aborted) {
      const stop = await this.cycle().catch((error: unknown) => {
        console.error('[connector] poll cycle failed', error)
        return this.backoff(UNREADABLE_ANSWER)
      })
      if (stop) {
        this.halt(stop)
      }
    }
    if (this.stopReason) {
      console.warn(`[connector] Orca Cloud stopped this connection: ${this.stopReason}`)
    }
  }

  /** One hello-if-needed and one held poll; returns why to stop, or null to go on. */
  private async cycle(): Promise<string | null> {
    const refused = await this.sayHello()
    if (refused) {
      return connectorStop(refused) ?? this.backoff(refused)
    }
    const { helloRev } = this
    // Stopped during the hello.
    if (helloRev === null) {
      return null
    }
    const holdMs = await this.wake.hold(helloRev, () => this.helloRev, this.stopped.signal)
    if (holdMs === null) {
      return null
    }
    const polledAt = Date.now()
    // The capability of the hello this poll runs under, whatever a newer one says by its answer.
    const outbox = this.options.events.replyAccount()
    const polled = await this.transport.call(
      CONNECTOR_PATHS.poll,
      // Only a poll on the wake channel says how long to hold; any other is held as before.
      holdMs === undefined ? { v: 1, helloRev } : { v: 1, helloRev, holdMs },
      ConnectorPollResponse,
      {
        timeoutMs: CONNECTOR_CLIENT_LIMITS.pollTimeoutMs,
        signal: this.stopped.signal
      }
    )
    // A stopped client admits nothing, even from an answer that arrived anyway.
    if (this.stopped.signal.aborted) {
      return null
    }
    if (!polled.ok) {
      // A hello in flight (sayChanged) may already replace this one: let it land before deciding.
      await this.saying.catch(() => null)
      // A lost answer (null) may have carried this hello's one list of unsettled deliveries; a new hello
      // lists them again. A 409 asks for one. A 5xx rolled back, so it keeps the hello. Either way only
      // if one said meanwhile did not already replace it.
      if (this.helloRev === helloRev && (polled.status === 409 || polled.status === null)) {
        this.helloRev = this.snapshots.drop(pollControl.connectorPollDropReason(polled))
        // A 409 that dropped this hello waits a random spread first: a deploy may have asked many
        // hosts at once. The first hello, and one a newer hello already answered, go at once.
        if (polled.status === 409) {
          return this.respread.wait(this.random, this.stopped.signal)
        }
      }
      return polled.status === 409 ? null : (connectorStop(polled) ?? this.backoff(polled))
    }
    const answeredAt = performance.now()
    // After a long sleep or outage, a fresh snapshot restates workers the cloud may have forgotten.
    const silentMs = Date.now() - (this.heardAt ?? Date.now())
    if (silentMs > HELLO_AFTER_SILENCE_MS && this.helloRev === helloRev) {
      this.helloRev = this.snapshots.drop('silence')
    }
    this.heardAt = polledAt
    this.failures = 0
    const response = polled.value
    this.deliveries.reconcileAll(response.unsettled ?? [])
    // serverNow is stamped when the cloud answers, after the hold, so the deadline runs from the answer.
    const msLeft = (expiresAt: number): number =>
      expiresAt - response.serverNow - (performance.now() - answeredAt)
    this.deliveries.deliverAll(response.deliveries, msLeft, outbox)
    return pollControl.obeyConnectorPollControl(response.control, this.random, this.stopped.signal)
  }

  private sayHello(): Promise<ConnectorFailure | null> {
    const say = (): Promise<ConnectorFailure | null> => this.helloIfOwed()
    // A failed one does not hold up the next.
    this.saying = this.saying.then(say, say)
    return this.saying
  }

  /** Null once the cloud took what this machine says now; otherwise why not. Each hello gets a fresh watch and snapshot. */
  private async helloIfOwed(again = true): Promise<ConnectorFailure | null> {
    await this.eventRequests.waitForRetry()
    const { machine } = this.options
    const said = connectorHelloSaid(machine, this.features)
    // A hello restarts the numbered events with a snapshot, which also restates anything the caps dropped.
    if (
      this.helloRev !== null &&
      JSON.stringify(said) === this.helloSaid &&
      !this.options.events.needsSnapshot
    ) {
      return null
    }
    const sent = await sayConnectorHello(machine, said, this.transport, this.stopped.signal)
    if (!sent.ok) {
      // A cloud rolled back to one without pages: ask again what it takes.
      this.features = said.paged && sent.status === 404 ? null : this.features
      return sent
    }
    const { answer, trimmed } = sent.value
    if (trimmed && !this.warnedTrimmed) {
      this.warnedTrimmed = true
      console.warn('[connector] the hello left out bots or triggers to fit what the cloud takes')
    }
    if (this.stopped.signal.aborted) {
      return null
    }
    this.helloSaid = JSON.stringify(said)
    this.botsSaid = said.bots !== null
    this.features = new Set(answer.features)
    const current = this.helloRev !== null
    this.helloRev = null
    this.options.events.useCloudFeatures(this.features, answer.helloRev)
    this.wake.offer(answer.wake ?? null)
    machine.helloAnswered?.(answer)
    // A fresh watch's first event is the snapshot, which opens this hello's numbered events.
    this.watch({ rev: answer.helloRev, again, current })
    this.helloRev = answer.helloRev
    this.eventSender.resume()
    this.deliveries.resume()
    // The answer's features can change what to say, e.g. bots left out until it said it takes pages.
    const changed = JSON.stringify(connectorHelloSaid(machine, this.features)) !== this.helloSaid
    return again && changed ? this.helloIfOwed(false) : null
  }

  private watch(hello?: ConnectorClientHello): void {
    this.snapshots.expect(hello)
    this.eventRequests.watch()
  }

  private readonly backoff = (failure: ConnectorFailure): Promise<null> =>
    pollControl.waitPollRetry(this.failures++, failure, this.random, this.stopped.signal)

  private async post(
    path: string,
    helloRev: number,
    body: unknown,
    // An events batch: the request is watched for its snapshot's trace, if it carries one.
    batch?: readonly ConnectorEvent[]
  ): Promise<ConnectorFailure | null> {
    const sent = await this.transport.call(path, body, z.undefined(), {
      signal: this.stopped.signal,
      requests: batch && this.options.events.requestsFor(batch)
    })
    if (sent.ok) {
      return null
    }
    // That hello is no longer current, e.g. a retired client's late one landed after it: say hello again.
    if (sent.status === 409 && this.helloRev === helloRev) {
      this.helloRev = this.snapshots.drop('post-409')
    }
    const stop = connectorStop(sent)
    if (stop) {
      this.halt(stop)
    }
    return sent
  }

  /** Only a running client may stop for a reason; a retired one's late answers mean nothing. */
  private halt(reason: string): void {
    if (!this.stopped.signal.aborted) {
      this.stopReason = reason
      this.stop()
      this.options.onHalt?.(reason)
    }
  }
}
