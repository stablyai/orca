// Who made an item event, as unseen marks compare people: the one rule for "changed by someone else".
import type { BotItemActor } from '../../shared/bots/bot-items'

/** The owner's viewer key; a teammate's is their Orca account. */
export const BOT_ITEM_OWNER_VIEWER = ''

/** An event's author as a viewer: the owner, a teammate by account, or null for an agent or Orca. */
export function botItemAuthorViewer(actor: BotItemActor): string | null {
  return actor.kind === 'owner' ? (actor.person?.accountId ?? BOT_ITEM_OWNER_VIEWER) : null
}

/** SQL for an `item_events` row the viewer bound to `?` did not make. */
export const BOT_ITEM_EVENT_NOT_BY_VIEWER = `NOT (json_extract(actor, '$.kind') = 'owner'
  AND IFNULL(json_extract(actor, '$.person.accountId'), '') = ?)`
