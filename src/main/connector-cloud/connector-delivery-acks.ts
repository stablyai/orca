// A client's deliveries in this process and their two confirmations, received and done, to the cloud.
import {
  ConnectorDeliveryId,
  type ConnectorAck,
  type ConnectorConversation
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import {
  dispatchDelivery,
  recordedDeliveryResult,
  type DispatchedDelivery
} from './connector-deliveries'
import { connectorDeliveryUnits, dispatchBatch } from './connector-delivery-batches'
import type { ConnectorMachine } from './connector-machine'
import {
  ConnectorOutbox,
  ConnectorOutboxSender,
  type ConnectorBatchSender
} from './connector-outbox'

const MAX_ACKS_PER_REQUEST = 100

export class ConnectorDeliveryAcks {
  private readonly acks: ConnectorOutbox<ConnectorAck>
  private readonly sender: ConnectorOutboxSender<ConnectorAck>
  // Received in this process and not yet confirmed done.
  private readonly active = new Set<string>()
  // Of those, the ones confirmed only by done (a trigger, a pull request event): never `received`, so
  // a quit before done leaves the cloud to resend them rather than reconcile them as unknown.
  private readonly onlyDone = new Set<string>()
  // Admitted through the reply outbox and not yet settled: `received` waits for the admission commit.
  private readonly unadmitted = new Set<string>()

  constructor(
    private readonly deps: {
      seam: ExternalConversationSeam
      host: ExternalConversationHost
      machine: ConnectorMachine
      send: ConnectorBatchSender<ConnectorAck>
      helloRev: () => number | null
      random: () => number
      signal: AbortSignal
      /** The account whose reply outbox admits deliveries, while the hello's answer lists
       *  replies.outbox; null otherwise (they go the legacy way). */
      outbox?: () => string | null
      /** The cloud took a `received`, or the `done` of a delivery never received: either lets the
       *  conversation's next delivery out, with no wake for it. */
      onUnblocked?: () => void
    }
  ) {
    this.acks = new ConnectorOutbox<ConnectorAck>({
      headSize: () => MAX_ACKS_PER_REQUEST,
      onAccepted: (sent) => {
        if (sent.some((ack) => ack.step === 'received' || this.onlyDone.has(ack.deliveryId))) {
          deps.onUnblocked?.()
        }
        for (const ack of sent.filter((sentAck) => sentAck.step === 'done')) {
          this.active.delete(ack.deliveryId)
          this.onlyDone.delete(ack.deliveryId)
        }
      }
    })
    this.sender = new ConnectorOutboxSender(this.acks, deps.send, deps.helloRev, deps.random)
  }

  /** A new hello: confirmations owed go out now. */
  resume(): void {
    this.sender.resume()
  }

  stop(): void {
    this.sender.stop()
  }

  /** Every delivery received here is confirmed done, and the cloud took each confirmation. */
  get settled(): boolean {
    return this.active.size === 0 && this.acks.size === 0
  }

  /** A poll's deliveries: a conversation's sends that waited behind its start or send run with it as
   *  one turn (connectorDeliveryUnits); everything else as it comes. */
  /** `outbox`: the reply outbox account of the hello the poll that handed these out ran under. */
  deliverAll(
    raws: readonly unknown[],
    msLeft: (expiresAt: number) => number,
    outbox: string | null = this.outbox()
  ): void {
    const { seam, host, machine } = this.deps
    const held = (delivery: { deliveryId: string; conversation: ConnectorConversation }) =>
      this.active.has(delivery.deliveryId) ||
      seam.receipts.known(delivery.conversation, delivery.deliveryId)
    for (const unit of connectorDeliveryUnits(raws, held)) {
      if ('raw' in unit) {
        this.deliver(unit.raw, msLeft, outbox)
        continue
      }
      if (unit.batch.length === 1) {
        this.deliver(unit.batch[0], msLeft, outbox)
        continue
      }
      for (const dispatched of dispatchBatch(seam, host, machine, unit.batch, msLeft, outbox)) {
        this.track(dispatched)
      }
    }
  }

  deliver(
    raw: unknown,
    msLeft: (expiresAt: number) => number,
    outbox: string | null = this.outbox()
  ): void {
    const id = ConnectorDeliveryId.safeParse(raw)
    // A lost `received` resends the delivery; this process already holds it.
    if (id.success && this.active.has(id.data.deliveryId)) {
      if (!this.onlyDone.has(id.data.deliveryId) && !this.unadmitted.has(id.data.deliveryId)) {
        this.push({ deliveryId: id.data.deliveryId, step: 'received' })
      }
      return
    }
    const { seam, host, machine } = this.deps
    const dispatched = dispatchDelivery(seam, host, machine, raw, msLeft, [], outbox)
    if (dispatched) {
      this.track(dispatched)
    }
  }

  private outbox(): string | null {
    return this.deps.outbox?.() ?? null
  }

  private track({ deliveryId, received, done, viaOutbox }: DispatchedDelivery): void {
    this.active.add(deliveryId)
    if (!received) {
      this.onlyDone.add(deliveryId)
    } else if (viaOutbox) {
      // Its outbox row commits with its admission: until then the cloud keeps it leased, so a crash
      // before the commit hands it out again rather than leaving it received and never answered.
      this.unadmitted.add(deliveryId)
    } else {
      this.push({ deliveryId, step: 'received' })
    }
    void done.then((result) => {
      // Only a committed admission is received; a refusal before the journal is done alone. Both
      // go in one push, so no request carries the received without its done.
      const unadmitted = this.unadmitted.delete(deliveryId)
      const admitted = unadmitted && result.outcome === 'accepted'
      // Refused before its admission: confirmed by done alone, like onlyDone.
      if (unadmitted && !admitted) {
        this.onlyDone.add(deliveryId)
      }
      this.push(...(admitted ? [{ deliveryId, step: 'received' as const }] : []), {
        deliveryId,
        step: 'done',
        result
      })
    })
  }

  /** Deliveries an earlier process received, as a poll lists them. */
  reconcileAll(
    unsettled: readonly { deliveryId: string; conversation: ConnectorConversation }[]
  ): void {
    for (const { deliveryId, conversation } of unsettled) {
      void this.reconcile(deliveryId, conversation)
    }
  }

  /** A delivery an earlier process received: replay its receipt, never run it again. */
  async reconcile(deliveryId: string, conversation: ConnectorConversation): Promise<void> {
    if (this.active.has(deliveryId)) {
      return
    }
    this.active.add(deliveryId)
    // Never run again, even when its outcome is unknown.
    const result = await recordedDeliveryResult(this.deps.seam, conversation, deliveryId)
    if (this.deps.signal.aborted) {
      return
    }
    this.push({ deliveryId, step: 'done', result })
  }

  private push(...acks: ConnectorAck[]): void {
    this.acks.push(...acks)
    this.sender.flush()
  }
}
