// Per-thread mute for a bot's Slack thread, decided before the agent sees the message: "mute" (or
// "be quiet", "stop responding in this thread") stops later replies reaching it until an @mention
// or "unmute". The bot's own posts (a background run's result, an automation) still go out.
import type {
  ConnectorConversation,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { SendDelivery } from './connector-deliveries'
import type { Delivery } from '../external-conversations/external-conversation-types'

import {
  addressesOtherBot,
  leadsWithBotUser,
  mayBeThreadMuteCommand,
  mentionsBot,
  threadMuteCommand,
  type ThreadBot
} from './connector-thread-mute-phrases'

/** What a send to a bot's thread does: a command is handled here and never reaches the agent; a
 *  muted thread silences any send that doesn't mention the bot; a mention unmutes and goes on. */
export type ThreadMuteStep = 'mute' | 'unmute' | 'silence' | 'unmute_and_send' | 'send'

/** What the person wrote: `text` also carries the thread before it, for an older Orca. */
export function spokenText(
  delivery: Pick<SendDelivery, 'text'> & { asker?: { text: string } }
): string {
  return delivery.asker?.text ?? delivery.text
}

export function threadMuteStep(
  muted: boolean,
  delivery: Pick<SendDelivery, 'text' | 'bareMention' | 'mentioned' | 'resume'> & {
    asker?: { text: string }
  },
  bot: ThreadBot
): ThreadMuteStep {
  const text = spokenText(delivery)
  // Resume is pressed on the bot's own failed turn: it goes on, and may still be refused, so it
  // leaves the mute as it was.
  if (delivery.resume) {
    return 'send'
  }
  const command = threadMuteCommand(text, bot)
  if (command) {
    return command
  }
  if (!muted) {
    return 'send'
  }
  // Another bot behind the same Slack app, named after its mention, leaves this one muted.
  if (addressesOtherBot(text, bot)) {
    return 'silence'
  }
  // `mentioned` comes only from a newer connector service; until then the bot's own mention in the
  // text counts.
  return delivery.mentioned || delivery.bareMention || mentionsBot(text, bot)
    ? 'unmute_and_send'
    : 'silence'
}

/** The bot's Slack user from a thread id (`T:C:ts:UBOT`); null for a DM (`T:D:D:UBOT`), which has
 *  no thread to mute. */
export function slackThreadBotUser(externalId: string): string | null {
  const [, , thread, userId] = externalId.split(':')
  return thread && /^\d+(?:\.\d+)?$/.test(thread) && userId ? userId : null
}

export const MUTED_EMOJI = ':mute:'
export const UNMUTED_EMOJI = ':loud_sound:'

export type ThreadMuteDeps = {
  /** The thread's bot and whether it is muted; `not_bot` for another chat's link, null for none. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | 'not_bot' | null
  /** Settles once the mute is on disk, so a command is never confirmed and then lost to a crash. */
  write: (key: ConnectorConversation, muted: boolean) => Promise<void>
  /** The names people @mention the bot by. */
  botNames: (botId: string) => string[]
  /** The names of this machine's other bots, which may share its Slack app. */
  otherBotNames: (botId: string) => string[]
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
        : await afterWait(Promise.resolve(wait), deps, delivery, record, userId)
    )
    return { decided: hold(deps, id, decided) }
  }
  // A reply behind one still deciding (its link being written, or its mute or unmute being saved)
  // waits its turn, so it is decided on what that one left and never overtakes it.
  const ahead = deps.waiting.get(id)
  if (ahead) {
    const waited = deps.queued(key, () => ahead.catch(() => undefined))
    return { decided: hold(deps, id, afterWait(waited, deps, delivery, record, userId)) }
  }
  const thread = deps.read(key)
  if (thread === 'not_bot') {
    return null
  }
  if (thread) {
    // Most replies to a thread that isn't muted are no command: they skip the bot's names.
    const applied =
      thread.muted || mayBeThreadMuteCommand(spokenText(delivery))
        ? applyStep(deps, delivery, record, userId, thread)
        : null
    return applied && { decided: hold(deps, id, applied.decided) }
  }
  // No link yet: a start in the same poll is still writing it. A likely command waits for it and
  // is then decided as any other; the rest go on now, batched as ever.
  if (!mayBeThreadMuteCommand(spokenText(delivery))) {
    return null
  }
  const linkedAt = deps.queued(key)
  return { decided: hold(deps, id, afterWait(linkedAt, deps, delivery, record, userId)) }
}

/** Decides a reply once its wait in the thread's queue is over; one a Stop settled while it waited
 *  is refused as the Stop refused it, never sent into a new queue. */
async function afterWait(
  waited: Promise<Delivery | undefined>,
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  userId: string
): Promise<ConnectorDeliveryResult | 'send' | 'carried'> {
  const wait = await waited
  return wait?.outcome === 'refused' ? wait : await decideNow(deps, delivery, record, userId)
}

async function decideNow(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  userId: string
): Promise<ConnectorDeliveryResult | 'send' | 'carried'> {
  const linked = deps.read(delivery.conversation)
  const applied =
    linked && linked !== 'not_bot' && applyStep(deps, delivery, record, userId, linked)
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
  userId: string,
  thread: { botId: string; muted: boolean }
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  // A reply with no mention and nothing like a command needs no names: most of a muted thread's.
  const plain = !spokenText(delivery).includes('@') && !mayBeThreadMuteCommand(spokenText(delivery))
  const step = threadMuteStep(thread.muted, delivery, {
    userId,
    names: plain ? [] : deps.botNames(thread.botId),
    // Only a reply leading with this bot's own Slack mention can be another bot's behind its app.
    others:
      plain || !leadsWithBotUser(spokenText(delivery), userId)
        ? []
        : deps.otherBotNames(thread.botId)
  })
  if (step === 'send') {
    return null
  }
  if (step === 'silence') {
    return { decided: record(async () => ACCEPTED) }
  }
  if (step === 'unmute_and_send') {
    // Unmuted now and goes on with its batch; the save's wait runs in the thread's queue just ahead
    // of its turn, so a save that works is on disk before the turn is admitted. A Stop cancels the
    // turn as it would any queued message; the unmute stays.
    const saving = deps
      .write(key, false)
      .catch((error: unknown) => console.warn('[connectors] could not save a thread unmute', error))
    void deps.queued(key, () => saving)
    return null
  }
  const ref = delivery.asker?.messageRef
  // Saved before its receipt, so a crash between leaves the resend to decide it again; a save that
  // fails is refused and sent again. The emoji shows only a mute (or unmute) already on disk.
  const decided = deps.write(key, step === 'mute').then(() =>
    record(async () => {
      if (ref) {
        // The emoji is the only answer: a failed one leaves the thread muted (or not) all the same.
        void deps
          .react(thread.botId, key, ref, step === 'mute' ? MUTED_EMOJI : UNMUTED_EMOJI)
          .catch((error: unknown) =>
            console.warn('[connectors] could not react to a thread mute', error)
          )
      }
      return ACCEPTED
    })
  )
  return { decided }
}
