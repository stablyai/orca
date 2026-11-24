// Per-thread mute for a bot's Slack thread, decided before the agent sees the message: once the bot
// has left the thread (`orca bot reply --leave-thread`), later replies stop reaching it until someone
// @mentions it. The bot's own posts (a background run's result, an automation) still go out.
import type {
  ConnectorConversation,
  ConnectorDelivery,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { SendDelivery } from './connector-deliveries'
import { refused, type Delivery } from '../external-conversations/external-conversation-types'

/** What a send to a bot's thread does: a muted thread silences any send that doesn't mention the
 *  bot; a mention unmutes and goes on. */
export type ThreadMuteStep = 'silence' | 'unmute_and_send' | 'send'

type MuteFacts = Pick<SendDelivery, 'bareMention' | 'mentioned' | 'resume'> & {
  asker?: { app?: true; via?: unknown }
}

/** Whether a person wrote it: another Slack app's message, or an Orca bot's on someone's behalf,
 *  never unmutes a bot, so no agent relaying a mention moves it. */
function byPerson(delivery: MuteFacts): boolean {
  return delivery.asker !== undefined && !delivery.asker.app && !delivery.asker.via
}

export function threadMuteStep(muted: boolean, delivery: MuteFacts): ThreadMuteStep {
  // Resume is pressed on the bot's own failed turn: it goes on, and may still be refused, so it
  // leaves the mute as it was.
  if (delivery.resume) {
    return 'send'
  }
  if (!muted) {
    return 'send'
  }
  return byPerson(delivery) && (delivery.mentioned || delivery.bareMention)
    ? 'unmute_and_send'
    : 'silence'
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

// An unmute that could not be saved: refused with nothing confirmed, so the thread offers
// Send again.
const NOT_SAVED = refused('thread_mute_not_saved')

export type ThreadMuteDeps = {
  /** The thread's bot and whether it is muted; `not_bot` for another chat's link, null for none. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | 'not_bot' | null
  /** Settles once the mute is on disk, and rejects with the previous value kept when it can't be,
   *  so a mute is never confirmed and then lost to a crash. */
  write: (key: ConnectorConversation, muted: boolean) => Promise<void>
  /** Runs `work` in the thread's queue after its queued deliveries (a start in the same poll
   *  writes its link there); a Stop settles it unrun. */
  queued: (
    key: ConnectorConversation,
    work?: () => Promise<unknown>
  ) => Promise<Delivery | undefined>
  /** Each thread's newest reply still deciding (its link being written, its mute being saved). */
  waiting: Map<string, Promise<unknown>>
}

const ACCEPTED = { outcome: 'accepted' } as const

/** Runs a handled send's effects under its durable delivery receipt, so a resend replays it. */
export type RecordHandled = (handled: () => Promise<Delivery>) => Promise<ConnectorDeliveryResult>

type Decided = ConnectorDeliveryResult | 'send' | 'carried'

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
    const decided = inPlace(deps, delivery, record, () => carriedBefore.catch(() => false))
    return { decided: hold(deps, id, decided) }
  }
  // A reply behind one still deciding (its link being written, or its mute or unmute being saved)
  // waits its turn, so it is decided on what that one left and never overtakes it.
  const ahead = deps.waiting.get(id)
  if (ahead) {
    const decided = inPlace(deps, delivery, record, async () => {
      await ahead.catch(() => undefined)
      return false
    })
    return { decided: hold(deps, id, decided) }
  }
  const thread = deps.read(key)
  if (thread === 'not_bot') {
    return null
  }
  // No link yet (a start in the same poll is still writing it), or not muted: it goes on at once.
  const applied = thread?.muted ? applyStep(deps, delivery, record) : null
  return applied && { decided: hold(deps, id, applied.decided) }
}

/** Takes the reply's place in the thread's queue now and decides it there once `before` settles
 *  (true: an earlier send carried it), so an unmute's save runs in that place too and is never
 *  queued again behind the replies after it. A Stop while it waits refuses it unrun; one that lands
 *  while a mention's unmute saves refuses the mention, and the thread stays unmuted. */
function inPlace(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  before: () => Promise<boolean>
): Promise<Decided> {
  let stopped = false
  let decision: Promise<Decided> | null = null
  const waited = deps.queued(delivery.conversation, async () => {
    const carried = await before()
    if (stopped) {
      return
    }
    decision = carried ? Promise.resolve('carried' as const) : decideNow(deps, delivery, record)
    await decision.catch(() => undefined)
  })
  return waited.then(async (wait) => {
    stopped = wait?.outcome === 'refused'
    const decided: Decided | null = decision ? await decision : null
    return wait?.outcome === 'refused' && (decided === null || decided === 'send')
      ? wait
      : (decided ?? 'send')
  })
}

async function decideNow(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled
): Promise<Decided> {
  const linked = deps.read(delivery.conversation)
  const applied =
    linked && linked !== 'not_bot' && linked.muted && applyStep(deps, delivery, record, 'in_place')
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
  // Already in its place in the thread's queue, so an unmute saves there and queues nothing more.
  place?: 'in_place'
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  const step = threadMuteStep(true, delivery)
  if (step === 'send') {
    return null
  }
  if (step === 'silence') {
    return { decided: record(async () => ACCEPTED) }
  }
  // The save waits in the thread's queue, so a Stop in the same poll still finds it and the mention
  // is refused with it, never answered after the Stop. Once saved, it goes on: the bot is never
  // answered as unmuted when it isn't.
  const saved = deps.write(key, false).then(
    () => true,
    (error: unknown) => {
      console.warn('[connectors] could not save a thread unmute', error)
      return false
    }
  )
  const sent = (ok: boolean) => (ok ? ('send' as const) : NOT_SAVED)
  if (place) {
    return { decided: saved.then(sent) }
  }
  const decided = deps
    .queued(key, () => saved)
    .then(async (wait) => (wait?.outcome === 'refused' ? wait : sent(await saved)))
  return { decided }
}
