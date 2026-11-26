// Remove when every supported release reads Waiting (BOTS_ITEM_WAITING_CAPABILITY).
// A client from before Waiting drops an item whose status it can't parse, so it is shown that item,
// its counts and its moves as In progress, the status it had before Waiting existed.
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import type { BotItem, BotItemEvent, BotItemStatus } from '../../../../shared/bots/bot-items'
import type { RpcContext } from '../core'

type WaitingReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsWaiting(ctx: WaitingReader): boolean {
  // An in-process or local-socket caller is this build; only a negotiated client can predate it.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(BOTS_ITEM_WAITING_CAPABILITY) === true
  )
}

const shown = (status: unknown): unknown => (status === 'waiting' ? 'working' : status)

export function botItemsForClient<T extends Pick<BotItem, 'status'>>(
  items: readonly T[],
  ctx: WaitingReader
): T[] {
  return readsWaiting(ctx)
    ? [...items]
    : items.map((item) => (item.status === 'waiting' ? { ...item, status: 'working' } : item))
}

export function botItemCountsForClient(
  counts: Partial<Record<BotItemStatus, number>>,
  ctx: WaitingReader
): Partial<Record<BotItemStatus, number>> {
  if (readsWaiting(ctx) || counts.waiting === undefined) {
    return counts
  }
  const { waiting, ...rest } = counts
  return { ...rest, working: (rest.working ?? 0) + waiting }
}

export function botItemEventsForClient(
  events: readonly BotItemEvent[],
  ctx: WaitingReader
): BotItemEvent[] {
  return readsWaiting(ctx)
    ? [...events]
    : events.map((event) =>
        event.kind === 'status' && (event.data.from === 'waiting' || event.data.to === 'waiting')
          ? {
              ...event,
              data: { ...event.data, from: shown(event.data.from), to: shown(event.data.to) }
            }
          : event
      )
}

/** A status filter as such a client meant it: its In progress includes Waiting. */
export function botItemStatusesForClient(
  statuses: readonly BotItemStatus[],
  ctx: WaitingReader
): readonly BotItemStatus[] {
  return !readsWaiting(ctx) && statuses.includes('working') && !statuses.includes('waiting')
    ? [...statuses, 'waiting']
    : statuses
}
