// Per-thread mute for a bot's Slack thread, decided before the agent sees the message: an exact
// directive ("stop listening to this thread") stops later replies reaching it until someone
// @mentions it. The bot's own posts (a background run's result, an automation) still go out.
import type {
  ConnectorConversation,
  ConnectorDelivery,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { SendDelivery } from './connector-deliveries'
import type { Delivery } from '../external-conversations/external-conversation-types'
import { isThreadMuteDirective } from './connector-thread-mute-phrases'

/** What a send to a bot's thread does: a directive mutes here and never reaches the agent; a muted
 *  thread silences any send that doesn't mention the bot; a mention unmutes and goes on. */
export type ThreadMuteStep = 'mute' | 'silence' | 'unmute_and_send' | 'send'

type MuteFacts = Pick<SendDelivery, 'bareMention' | 'mentioned' | 'resume'> & {
  asker?: { text: string }
}

export function threadMuteStep(
  muted: boolean,
  delivery: MuteFacts,
  botNames: readonly string[]
): ThreadMuteStep {
  // Resume is pressed on the bot's own failed turn: it goes on, and may still be refused, so it
  // leaves the mute as it was.
  if (delivery.resume) {
    return 'send'
  }
  // Only the sender's own words, never the thread context sent with them; "@Bot stop listening
  // here" mutes, as its mention is stripped.
  if (isThreadMuteDirective(delivery.asker?.text, botNames)) {
    return 'mute'
  }
  if (!muted) {
    return 'send'
  }
  return delivery.mentioned || delivery.bareMention ? 'unmute_and_send' : 'silence'
}

/** Whether a send may be a directive to stop listening, kept out of batches so it is never carried
 *  into the turn before it as words. */
export function mayBeThreadMuteDirective(delivery: { asker?: { text: string } }): boolean {
  return isThreadMuteDirective(delivery.asker?.text, 'any')
}

/** The bot's Slack user from a thread id (`T:C:ts:UBOT`); null for a DM (`T:D…`), which has no
 *  thread to mute. */
export function slackThreadBotUser(externalId: string): string | null {
  const [, channel, thread, userId] = externalId.split(':')
  return channel && !channel.startsWith('D') && thread && /^\d+(?:\.\d+)?$/.test(thread) && userId
    ? userId
    : null
}

/** A send the thread's mute handled starts no turn, and so none of its automations: the cloud is told
 *  they were taken, so it never starts them on their own. */
export function withoutAutomations(
  delivery: ConnectorDelivery,
  result: ConnectorDeliveryResult
): ConnectorDeliveryResult {
  return result.outcome === 'accepted' && delivery.kind === 'send' && delivery.automations?.length
    ? { ...result, inTurn: true }
    : result
}

export const MUTED_EMOJI = ':mute:'

// A mute or unmute that could not be saved: refused, and nothing confirmed, so it is sent again.
const NOT_SAVED = { outcome: 'refused', reason: 'thread_mute_not_saved' } as const

export type ThreadMuteDeps = {
  /** The thread's bot and whether it is muted; `not_bot` for another chat's link, null for none. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | 'not_bot' | null
  /** Settles once the mute is on disk, and rejects with the previous value kept when it can't be,
   *  so a mute is never confirmed and then lost to a crash. */
  write: (key: ConnectorConversation, muted: boolean) => Promise<void>
  /** The names the bot goes by ("Reviewer stop listening here", on a Slack app several bots share). */
  botNames: (botId: string) => string[]
  /** Runs `work` in the thread's queue after its queued deliveries (a start in the same poll
   *  writes its link there); a Stop settles it unrun. */
  queued: (
    key: ConnectorConversation,
    work?: () => Promise<unknown>
  ) => Promise<Delivery | undefined>
  /** Each thread's newest reply still deciding (its link being written, its mute being saved). */
  waiting: Map<string, Promise<unknown>>
  react: (
    botId: string,
    key: ConnectorConversation,
    messageRef: string,
    emoji: string
  ) => Promise<void>
}

const ACCEPTED = { outcome: 'accepted' } as const

/** Runs a handled send's effects under its durable delivery receipt, so a resend replays it. */
export type RecordHandled = (
  handled: () => Promise<typeof ACCEPTED>
) => Promise<ConnectorDeliveryResult>

/** A send this step holds: its result (accepted with no turn), or 'send' when it goes on once
 *  decided. */
export type ThreadMuteOutcome = { decided: Promise<ConnectorDeliveryResult | 'send' | 'carried'> }

/** The send's outcome when this step holds it; null when it goes on to the agent now. */
export function handleThreadMute(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  // A later send of a held batch: whether an earlier send of it carried this one into its turn.
  carriedBefore?: Promise<boolean>
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  const userId = key.source === 'slack' ? slackThreadBotUser(key.externalId) : null
  if (!userId) {
    return null
  }
  const id = JSON.stringify([key.source, key.externalId])
  // Its place is taken now, behind the send before it, so nothing later in the poll overtakes it.
  if (carriedBefore) {
    const waited = deps.queued(key, () => carriedBefore.catch(() => false))
    const decided = waited.then(async (wait) =>
      (await carriedBefore.catch(() => false))
        ? ('carried' as const)
        : await afterWait(Promise.resolve(wait), deps, delivery, record)
    )
    return { decided: hold(deps, id, decided) }
  }
  // A reply behind one still deciding (its link being written, or its mute or unmute being saved)
  // waits its turn, so it is decided on what that one left and never overtakes it.
  const ahead = deps.waiting.get(id)
  if (ahead) {
    const waited = deps.queued(key, () => ahead.catch(() => undefined))
    return { decided: hold(deps, id, afterWait(waited, deps, delivery, record)) }
  }
  const thread = deps.read(key)
  if (thread === 'not_bot') {
    return null
  }
  if (thread) {
    // Most replies to a thread that isn't muted are no directive: they skip the bot's names.
    const applied =
      thread.muted || mayBeThreadMuteDirective(delivery)
        ? applyStep(deps, delivery, record, thread)
        : null
    return applied && { decided: hold(deps, id, applied.decided) }
  }
  // No link yet: a start in the same poll is still writing it. A likely directive waits for it and
  // is then decided as any other; the rest go on now, batched as ever.
  if (!mayBeThreadMuteDirective(delivery)) {
    return null
  }
  const linkedAt = deps.queued(key)
  return { decided: hold(deps, id, afterWait(linkedAt, deps, delivery, record)) }
}

/** Decides a reply once its wait in the thread's queue is over; one a Stop settled while it waited
 *  is refused as the Stop refused it, never sent into a new queue. */
async function afterWait(
  waited: Promise<Delivery | undefined>,
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled
): Promise<ConnectorDeliveryResult | 'send' | 'carried'> {
  const wait = await waited
  return wait?.outcome === 'refused' ? wait : await decideNow(deps, delivery, record)
}

async function decideNow(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled
): Promise<ConnectorDeliveryResult | 'send' | 'carried'> {
  const linked = deps.read(delivery.conversation)
  const applied = linked && linked !== 'not_bot' && applyStep(deps, delivery, record, linked)
  return applied ? await applied.decided : 'send'
}

/** Keeps the thread's newest deciding reply until it settles, for the replies behind it. */
function hold<Decided>(
  deps: ThreadMuteDeps,
  id: string,
  decided: Promise<Decided>
): Promise<Decided> {
  deps.waiting.set(id, decided)
  void decided
    .catch(() => undefined)
    .finally(() => {
      if (deps.waiting.get(id) === decided) {
        deps.waiting.delete(id)
      }
    })
  return decided
}

function applyStep(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  thread: { botId: string; muted: boolean }
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  const step = threadMuteStep(
    thread.muted,
    delivery,
    // Most of a muted thread's replies are no directive and need no names.
    mayBeThreadMuteDirective(delivery) ? deps.botNames(thread.botId) : []
  )
  if (step === 'send') {
    return null
  }
  if (step === 'silence') {
    return { decided: record(async () => ACCEPTED) }
  }
  // Saved, then its receipt, then its emoji: a crash between leaves the resend to decide it again,
  // and a save that fails is refused with nothing confirmed. A mention goes on only once unmuted on
  // disk, so the bot is never answered as unmuted when it isn't.
  const saved = deps.write(key, step === 'mute').then(
    () => true,
    (error: unknown) => {
      console.warn('[connectors] could not save a thread mute', error)
      return false
    }
  )
  if (step === 'unmute_and_send') {
    return { decided: saved.then((ok) => (ok ? 'send' : NOT_SAVED)) }
  }
  const ref = delivery.asker?.messageRef
  const decided = saved.then(async (ok) => {
    if (!ok) {
      return NOT_SAVED
    }
    const result = await record(async () => ACCEPTED)
    if (ref && result.outcome === 'accepted') {
      // The emoji is the only answer: a failed one leaves the thread muted all the same.
      void deps
        .react(thread.botId, key, ref, MUTED_EMOJI)
        .catch((error: unknown) =>
          console.warn('[connectors] could not react to a thread mute', error)
        )
    }
    return result
  })
  return { decided }
}
