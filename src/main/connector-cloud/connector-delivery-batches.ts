// A poll's deliveries grouped so a thread's messages that waited together for this machine run as
// one turn.
import {
  CONNECTOR_CLIENT_LIMITS,
  ConnectorDelivery
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
import { mayBeThreadMuteCommand, slackThreadBotUser } from './connector-thread-mute'

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
        mayBeThreadMuteCommand(delivery.text)
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
  // Refused before the seam (expired, unsupported), or held by a thread's mute: the later ones go
  // on their own, unless the held one carries them.
  const carried =
    first.received || first.carriesLater
      ? later.map((delivery): DispatchedDelivery => ({
          deliveryId: delivery.deliveryId,
          received: true,
          ...(first.viaOutbox || (first.carriesLater && outboxAccount)
            ? { viaOutbox: true as const }
            : {}),
          done: seam.receipts.carried(
            delivery.conversation,
            delivery.deliveryId,
            delivery.text,
            first.done
          )
        }))
      : later.flatMap((delivery) => {
          const own = dispatchDelivery(seam, host, machine, delivery, msLeft, [], outboxAccount)
          return own ? [own] : []
        })
  return [
    first,
    ...carried,
    ...late.map((delivery) => refuse(delivery.deliveryId, { outcome: 'expired' }))
  ]
}
