// The CLI's words for item statuses. In progress is stored as `working`; agents only ever see
// `in-progress` (flags) and `in_progress` (--json), so the stored name never reaches them.
import {
  BOT_ITEM_STATUSES,
  type BotItem,
  type BotItemEvent,
  type BotItemStatus
} from '../../shared/bots/bot-items'

const FLAGS: Record<BotItemStatus, string> = {
  planned: 'planned',
  working: 'in-progress',
  needs_you: 'needs-you',
  done: 'done',
  canceled: 'canceled'
}

function jsonStatus(value: unknown): unknown {
  return value === 'working' ? 'in_progress' : value
}

/** `--status` input: the flag word or its --json name. */
export function botItemStatusFromCli(value: string): BotItemStatus | null {
  const word = value.trim()
  return (
    BOT_ITEM_STATUSES.find((status) => FLAGS[status] === word || jsonStatus(status) === word) ??
    null
  )
}

export function botItemStatusFlagWords(): string {
  return BOT_ITEM_STATUSES.map((status) => FLAGS[status]).join(', ')
}

export type BotItemsView = {
  item?: BotItem
  items?: BotItem[]
  events?: BotItemEvent[]
  counts?: Partial<Record<BotItemStatus, number>>
}

function jsonItem(item: BotItem): Record<string, unknown> {
  return { ...item, status: jsonStatus(item.status) }
}

function jsonEvent(event: BotItemEvent): BotItemEvent {
  const { data } = event
  if (event.kind === 'status') {
    return { ...event, data: { ...data, from: jsonStatus(data.from), to: jsonStatus(data.to) } }
  }
  return event.kind === 'made'
    ? { ...event, data: { ...data, status: jsonStatus(data.status) } }
    : event
}

/** A bots.items result as --json prints it: every status by its CLI name. */
export function botItemJsonView(view: BotItemsView): Record<string, unknown> {
  return {
    ...view,
    ...(view.item ? { item: jsonItem(view.item) } : {}),
    ...(view.items ? { items: view.items.map(jsonItem) } : {}),
    ...(view.events ? { events: view.events.map(jsonEvent) } : {}),
    ...(view.counts
      ? {
          counts: Object.fromEntries(
            Object.entries(view.counts).map(([status, count]) => [jsonStatus(status), count])
          )
        }
      : {})
  }
}
