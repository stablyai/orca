// The machine side of the connector: one held poll, two confirmations per delivery, and turn events back.
import { z } from 'zod'
import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_PATHS,
  ConnectorDeliveryId,
  ConnectorHelloResponse,
  ConnectorPollControl,
  ConnectorPollResponse,
  type ConnectorReplyResponse,
  type ConnectorAck,
  type ConnectorConversation,
  type ConnectorDeliveryResult,
  type ConnectorEvent
} from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import {
  UNREADABLE_ANSWER,
  type ConnectorFailure,
  type ConnectorResult
} from './connector-cloud-request'
import { dispatchDelivery } from './connector-deliveries'
import { connectorHello, type ConnectorHelloSaid } from './connector-hello'
import type { ConnectorMachine, ConnectorTransport } from './connector-machine'
import { postConnectorReply, type ConnectorReplyBody } from './connector-replies'
import { connectorRetryDelayMs, ConnectorOutbox, ConnectorOutboxSender } from './connector-outbox'
import type { ConnectorTurnEvents } from './connector-turn-events'

const RECONNECT_SPREAD_MS = 2_000
const MAX_ACKS_PER_REQUEST = 100

export type ConnectorPollClientOptions = {
  transport: ConnectorTransport
  /** Owned by the caller across clients; this client only sends through it while running. */
  events: ConnectorTurnEvents
  seam: ExternalConversationSeam
  machine: ConnectorMachine
  random?: () => number
}

/** Why the cloud stopped this client, e.g. `client_too_old`; it stays stopped until replaced. */
type Stop = string

/** A refusal no retry can fix; any other failure, a lapsed sign-in included, is retried after a backoff. */
function stopFor(failure: ConnectorFailure): Stop | null {
  return failure.status === 426 ? 'client_too_old' : null
}

export class ConnectorPollClient {
  readonly seam: ExternalConversationSeam
  private readonly host: ExternalConversationHost
  private readonly transport: ConnectorTransport
  private readonly stopped = new AbortController()
  private readonly acks: ConnectorOutbox<ConnectorAck>
  private readonly ackSender: ConnectorOutboxSender<ConnectorAck>
  private readonly eventSender: ConnectorOutboxSender<ConnectorEvent>
  // Received in this process and not yet confirmed done.
  private readonly active = new Set<string>()
  private readonly random: () => number
  private releaseWatch: (() => void) | null = null
  // The hello the cloud took, which scopes the poll and everything sent; null until then, once the cloud
  // says it is no longer current, and once stopped. A new hello only replaces it. The cloud refuses
  // anything under another hello with 409, so a 204 always means applied.
  private helloRev: number | null = null
  // What that hello said.
  private helloSaid = ''
  private failures = 0
  private warnedTrimmed = false
  private stopReason: Stop | null = null

  constructor(private readonly options: ConnectorPollClientOptions) {
    this.seam = options.seam
    this.transport = options.transport
    this.random = options.random ?? Math.random
    this.host = options.machine.conversationHost()
    this.acks = new ConnectorOutbox<ConnectorAck>({
      headSize: () => MAX_ACKS_PER_REQUEST,
      onAccepted: (sent) => {
        for (const ack of sent) {
          if (ack.step === 'done') {
            this.active.delete(ack.deliveryId)
          }
        }
      }
    })
    const helloRev = (): number | null => this.helloRev
    this.ackSender = new ConnectorOutboxSender(
      this.acks,
      (acks, rev) => this.post(CONNECTOR_PATHS.acks, rev, { v: 1, helloRev: rev, acks }),
      helloRev,
      this.random
    )
    // Every hello restarts the numbering with a snapshot.
    this.eventSender = new ConnectorOutboxSender(
      options.events,
      (events, rev, seq) =>
        this.post(CONNECTOR_PATHS.events, rev, { v: 1, helloRev: rev, seq, events }),
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

  /** Posts an agent's reply to its conversation's thread while this client runs. */
  reply(body: ConnectorReplyBody): Promise<ConnectorResult<ConnectorReplyResponse>> {
    return postConnectorReply(this.transport, body, this.stopped.signal, this.random)
  }

  stop(): void {
    this.stopped.abort()
    // Confirmations still owed are listed as unsettled after the next hello and settled from receipts.
    this.helloRev = null
    this.ackSender.stop()
    this.eventSender.stop()
    this.releaseWatch?.()
    this.releaseWatch = null
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      let stop: Stop | null
      try {
        stop = await this.cycle()
      } catch (error) {
        console.error('[connector] poll cycle failed', error)
        stop = await this.backoff(UNREADABLE_ANSWER)
      }
      if (stop) {
        this.halt(stop)
      }
    }
    if (this.stopReason) {
      console.warn(`[connector] Orca Cloud stopped this connection: ${this.stopReason}`)
    }
  }

  /** One hello-if-needed and one held poll; returns why to stop, or null to go on. */
  private async cycle(): Promise<Stop | null> {
    const { machine } = this.options
    const said = { agents: machine.agents(), projects: machine.projects() }
    // A hello restarts the numbered events with a snapshot, which also restates anything the caps dropped.
    if (
      this.helloRev === null ||
      JSON.stringify(said) !== this.helloSaid ||
      this.options.events.needsSnapshot
    ) {
      const refused = await this.hello(said)
      if (refused) {
        return stopFor(refused) ?? this.backoff(refused)
      }
    }
    const { helloRev } = this
    // Stopped during the hello.
    if (helloRev === null) {
      return null
    }
    const sentAt = performance.now()
    const polled = await this.transport.call(
      CONNECTOR_PATHS.poll,
      { v: 1, helloRev },
      ConnectorPollResponse,
      { timeoutMs: CONNECTOR_CLIENT_LIMITS.pollTimeoutMs, signal: this.stopped.signal }
    )
    // A stopped client admits nothing, even from an answer that arrived anyway.
    if (this.stopped.signal.aborted) {
      return null
    }
    if (!polled.ok) {
      // A lost answer may have carried this hello's one list of unsettled deliveries; a new hello lists
      // them again. A 409 means the cloud wants one anyway.
      this.helloRev = null
      return polled.status === 409 ? null : (stopFor(polled) ?? this.backoff(polled))
    }
    this.failures = 0
    const response = polled.value
    for (const unsettled of response.unsettled ?? []) {
      void this.reconcile(unsettled.deliveryId, unsettled.conversation)
    }
    // Network delay only shortens the deadline: it runs from when this poll was sent.
    const msLeft = (expiresAt: number): number =>
      expiresAt - response.serverNow - (performance.now() - sentAt)
    for (const raw of response.deliveries) {
      this.deliver(raw, msLeft)
    }
    return this.obey(response.control)
  }

  /** Null once the cloud took it; otherwise why not. Each hello also gets a fresh watch and snapshot. */
  private async hello(said: ConnectorHelloSaid): Promise<ConnectorFailure | null> {
    const { body, trimmed } = connectorHello(this.options.machine, said)
    if (trimmed && !this.warnedTrimmed) {
      this.warnedTrimmed = true
      console.warn('[connector] the hello left out the least recently used projects to fit its cap')
    }
    const answer = await this.transport.call(CONNECTOR_PATHS.hello, body, ConnectorHelloResponse, {
      method: 'PUT',
      signal: this.stopped.signal
    })
    if (!answer.ok) {
      return answer
    }
    if (this.stopped.signal.aborted) {
      return null
    }
    this.helloSaid = JSON.stringify(said)
    // A fresh watch's first event is the snapshot, which opens this hello's numbered events.
    this.watch()
    this.helloRev = answer.value.helloRev
    this.eventSender.resume()
    this.ackSender.resume()
    return null
  }

  private watch(): void {
    const { events } = this.options
    const previous = this.releaseWatch
    this.releaseWatch = this.seam.watch(this.host, (event) => {
      events.observe(event)
      this.eventSender.flush()
    })
    previous?.()
  }

  private deliver(raw: unknown, msLeft: (expiresAt: number) => number): void {
    const id = ConnectorDeliveryId.safeParse(raw)
    // A lost `received` resends the delivery; this process already holds it.
    if (id.success && this.active.has(id.data.deliveryId)) {
      this.pushAck({ deliveryId: id.data.deliveryId, step: 'received' })
      return
    }
    const dispatched = dispatchDelivery(this.seam, this.host, raw, msLeft)
    if (!dispatched) {
      return
    }
    const { deliveryId, received, done } = dispatched
    this.active.add(deliveryId)
    if (received) {
      this.pushAck({ deliveryId, step: 'received' })
    }
    void done.then((result) => this.pushAck({ deliveryId, step: 'done', result }))
  }

  /** A delivery an earlier process received: replay its receipt, never run it again. */
  private async reconcile(deliveryId: string, conversation: ConnectorConversation): Promise<void> {
    if (this.active.has(deliveryId)) {
      return
    }
    this.active.add(deliveryId)
    // A receipt still running can fail; its outcome is then unknown, and it is still never run again.
    const result: ConnectorDeliveryResult = await this.seam.recorded(conversation, deliveryId).then(
      (recorded) => recorded ?? { outcome: 'unknown', reason: 'no_local_record' },
      (error: unknown) => ({
        outcome: 'unknown',
        reason: error instanceof Error && error.message ? error.message : 'failed'
      })
    )
    if (this.stopped.signal.aborted) {
      return
    }
    this.pushAck({ deliveryId, step: 'done', result })
  }

  private pushAck(ack: ConnectorAck): void {
    this.acks.push(ack)
    this.ackSender.flush()
  }

  private async obey(raw: unknown): Promise<Stop | null> {
    const control = ConnectorPollControl.safeParse(raw)
    if (!control.success) {
      return null
    }
    if ('stop' in control.data) {
      return control.data.stop
    }
    const waitMs =
      'pausedForMs' in control.data ? control.data.pausedForMs : this.random() * RECONNECT_SPREAD_MS
    await delayUnlessAborted(waitMs, this.stopped.signal)
    return null
  }

  private async backoff(failure: ConnectorFailure): Promise<null> {
    await delayUnlessAborted(
      connectorRetryDelayMs(this.failures++, failure, this.random),
      this.stopped.signal
    )
    return null
  }

  private async post(
    path: string,
    helloRev: number,
    body: unknown
  ): Promise<ConnectorFailure | null> {
    const sent = await this.transport.call(path, body, z.undefined(), {
      signal: this.stopped.signal
    })
    if (sent.ok) {
      return null
    }
    // That hello is no longer current, e.g. a retired client's late one landed after it: say hello again.
    if (sent.status === 409 && this.helloRev === helloRev) {
      this.helloRev = null
    }
    const stop = stopFor(sent)
    if (stop) {
      this.halt(stop)
    }
    return sent
  }

  /** Only a running client may stop for a reason; a retired one's late answers mean nothing. */
  private halt(reason: Stop): void {
    if (!this.stopped.signal.aborted) {
      this.stopReason = reason
      this.stop()
    }
  }
}
