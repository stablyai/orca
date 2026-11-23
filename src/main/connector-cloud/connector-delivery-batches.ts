// A poll's deliveries grouped so a thread's messages that waited together for this machine run as
// one turn.
import {
  CONNECTOR_CLIENT_LIMITS,
  ConnectorDelivery,
  type ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import {
  dispatchDelivery,
  refuse,
  type DispatchedDelivery,
  type DispatchMachine,
  type RequestDelivery,
  type SendDelivery,
  type ThreadDelivery
} from './connector-deliveries'
import { slackThreadBotUser, spokenText } from './connector-thread-mute'
import { mayBeThreadMuteCommand } from './connector-thread-mute-phrases'

/** A start or send and the sends queued right behind it in the same poll: the same person's, run
 *  as one turn. Anything else, and a send that is its own bare mention, goes on its own. */
export type DeliveryUnit = { raw: unknown } | { batch: [RequestDelivery, ...SendDelivery[]] }

const askerOf = (delivery: RequestDelivery) => delivery.asker?.userId ?? null

/**
 * Groups a poll's deliveries, keeping each conversation's order: a start or send takes the sends
 * of its conversation that follow it with nothing else of that conversation between, from the same
 * person. `held` names deliveries this machine already holds or ran, which go on their own so a
 * resend replays its receipt.
 */
export function connectorDeliveryUnits(
  raws: readonly unknown[],
  held: (delivery: ThreadDelivery) => boolean
): DeliveryUnit[] {
  const units: DeliveryUnit[] = []
  // Each conversation's open batch, while the next of its deliveries may still join it.
  const open = new Map<string, [RequestDelivery, ...SendDelivery[]]>()
  for (const raw of raws) {
    const parsed = ConnectorDelivery.safeParse(raw)
    const delivery = parsed.success ? parsed.data : null
    if (
      !delivery ||
      delivery.kind === 'trigger' ||
      delivery.kind === 'webhook_notice' ||
      delivery.kind === 'pr_event'
    ) {
      units.push({ raw })
      continue
    }
    const key = JSON.stringify([delivery.conversation.source, delivery.conversation.externalId])
    const batch = open.get(key)
    // A resume runs alone: its not_failed check guards only its own turn.
    const eligible =
      (delivery.kind === 'start' || (delivery.kind === 'send' && !delivery.resume)) &&
      !held(delivery)
    if (
      batch &&
      eligible &&
      delivery.kind === 'send' &&
      !delivery.bareMention &&
      !delivery.asker?.earlierOwn &&
      // A mute command in a bot's Slack thread is handled alone, never as words of the turn before it.
      !(
        delivery.conversation.source === 'slack' &&
        slackThreadBotUser(delivery.conversation.externalId) !== null &&
        mayBeThreadMuteCommand(spokenText(delivery))
      ) &&
      askerOf(delivery) === askerOf(batch[0])
    ) {
      batch.push(delivery)
      continue
    }
    open.delete(key)
    if (eligible) {
      const started: [RequestDelivery, ...SendDelivery[]] = [delivery]
      open.set(key, started)
      units.push({ batch: started })
    } else {
      units.push({ raw })
    }
  }
  return units
}

/**
 * Runs a batch as one turn: its first delivery carries the later ones' words, each with when it
 * was sent, and each later one's receipt is the first's outcome. A later one too close to its
 * deadline is refused on its own, as any delivery would be.
 */
export function dispatchBatch(
  seam: ExternalConversationSeam,
  host: ExternalConversationHost,
  machine: DispatchMachine,
  batch: readonly [RequestDelivery, ...SendDelivery[]],
  msLeft: (expiresAt: number) => number,
  outboxAccount: string | null = null
): DispatchedDelivery[] {
  const [head, ...rest] = batch
  const late = rest.filter(
    (delivery) => msLeft(delivery.expiresAt) < CONNECTOR_CLIENT_LIMITS.minDeadlineLeftMs
  )
  const later = rest.filter((delivery) => !late.includes(delivery))
  const first = dispatchDelivery(seam, host, machine, head, msLeft, later, outboxAccount)
  if (!first) {
    return late.map((delivery) => refuse(delivery.deliveryId, { outcome: 'expired' }))
  }
  const carriedBy = (done: Promise<ConnectorDeliveryResult>) => (delivery: SendDelivery) =>
    seam.receipts.carried(delivery.conversation, delivery.deliveryId, delivery.text, done)
  const [next, ...after] = later
  // Held by a thread's mute: the later ones wait for its decision, then go with it as one turn, or
  // (silenced, a command) on as a batch of their own, so a request and its follow-ups stay together.
  const heldLater = first.carriedLater
  const carried: DispatchedDelivery[] = heldLater
    ? (() => {
        const rest = heldLater.then((carries) => {
          if (carries || !next) {
            return new Map(
              later.map((delivery) => [delivery.deliveryId, carriedBy(first.done)(delivery)])
            )
          }
          const own = dispatchBatch(seam, host, machine, [next, ...after], msLeft, outboxAccount)
          return new Map(own.map((entry) => [entry.deliveryId, entry.done]))
        })
        return later.map((delivery) => ({
          deliveryId: delivery.deliveryId,
          received: false,
          done: rest.then(
            (dones) =>
              dones.get(delivery.deliveryId) ?? { outcome: 'unknown', reason: 'not_dispatched' }
          )
        }))
      })()
    : first.received
      ? later.map((delivery): DispatchedDelivery => ({
          deliveryId: delivery.deliveryId,
          received: true,
          ...(first.viaOutbox ? { viaOutbox: true as const } : {}),
          done: carriedBy(first.done)(delivery)
        }))
      : // Refused before the seam (expired, unsupported): the later ones go on as their own batch.
        next
        ? dispatchBatch(seam, host, machine, [next, ...after], msLeft, outboxAccount)
        : []
  return [
    first,
    ...carried,
    ...late.map((delivery) => refuse(delivery.deliveryId, { outcome: 'expired' }))
  ]
}
