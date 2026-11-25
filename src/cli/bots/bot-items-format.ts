// `orca bot item`: one short line per write, one row per item, and an item with its activity.
import {
  botItemCommentImages,
  BOT_ITEM_STATUSES,
  isBotItemSnoozed,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView,
  type BotItemStatus
} from '../../shared/bots/bot-items'

export type BotItemWriteView = {
  item: BotItem
  eventId: string | null
  created?: boolean
  unchanged?: boolean
  advice?: { codes: string[]; tip: string }
}

export type BotItemListView = {
  botId: string
  botName: string
  items: BotItem[]
  counts: Partial<Record<BotItemStatus, number>>
  nextCursor?: string
}

export type BotItemShowView = { item: BotItem; events: BotItemEvent[]; nextCursor?: string }

const STATUS_WORDS: Record<BotItemStatus, string> = {
  planned: 'Planned',
  working: 'In progress',
  waiting: 'Waiting',
  needs_you: 'Needs you',
  done: 'Done',
  canceled: 'Canceled'
}

/** An event's stored status in the same words as the header; anything unknown as written. */
function statusWord(value: unknown): string {
  const status = BOT_ITEM_STATUSES.find((entry) => entry === value)
  return status ? STATUS_WORDS[status] : String(value ?? '')
}

/** A title on the header's one line, however it was written. */
function titleLine(item: BotItem): string {
  return item.title.replace(/\s+/g, ' ').trim()
}

function chatWords(item: BotItem): string {
  return item.chat.title ?? (item.chat.kind === 'home' ? 'Home Chat' : `chat:${item.chat.id}`)
}

export function formatBotItemWrite(view: BotItemWriteView): string {
  const { item } = view
  const lines = [
    [
      `item ${item.number}`,
      STATUS_WORDS[item.status],
      ...(item.madeBy && item.owner.botId !== item.madeBy.botId
        ? [`for ${item.owner.name ?? item.owner.botId}`]
        : []),
      titleLine(item),
      chatWords(item),
      ...(view.unchanged ? ['nothing changed'] : [])
    ].join(' · ')
  ]
  if (view.advice) {
    lines.push(view.advice.tip)
  }
  return lines.join('\n')
}

function linkSummary(links: readonly BotItemLinkView[]): string[] {
  const workers = links.filter((link) => link.kind === 'dispatch')
  const parts =
    workers.length > 0 ? [`${workers.length} worker${workers.length === 1 ? '' : 's'}`] : []
  for (const link of links) {
    const pr = link.kind === 'pr' || link.kind === 'dispatch' ? link.pr : null
    if (pr?.shown) {
      parts.push(`#${pr.number}`)
    } else if (pr && !pr.shown) {
      parts.push('PR not shown for server work yet')
    }
  }
  return [...new Set(parts)]
}

function age(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** `2026-11-19 09:00 (-05:00)`: this computer's time, with its offset so it reads anywhere. */
export function formatSnoozeTime(at: number): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())} (${zone})`
}

/** What the bot reads on a snoozed item, in list and show: it carries the guidance, not the Rules. */
function snoozedWords(until: string): string {
  return `by your owner until ${until}: don't ask about it before then; comments and worker results stay hidden from them until then, and setting it to Needs you or closing it brings it back now`
}

/** When the owner's snooze ends, while it lasts. */
function snoozedUntil(item: BotItem, now: number): string | null {
  return isBotItemSnoozed(item, now) && item.snoozedUntil !== null
    ? formatSnoozeTime(item.snoozedUntil)
    : null
}

export function formatBotItemRow(item: BotItem, now: number): string {
  const what = [item.title, ...linkSummary(item.links)].join(' · ')
  const until = snoozedUntil(item, now)
  const snoozed = until ? `\n    snoozed ${snoozedWords(until)}` : ''
  const question = item.question ? `\n    asks: ${item.question.text.split('\n')[0]}` : ''
  const wait = item.wait ? `\n    waits on: ${item.wait.text}` : ''
  return `${item.number}  ${STATUS_WORDS[item.status]}  ${what}  ${chatWords(item)}  ${age(item.updatedAt, now)}${snoozed}${question}${wait}`
}

export function formatBotItemList(view: BotItemListView, now: number): string {
  const rows =
    view.items.length === 0
      ? [`${view.botName} has no items here.`]
      : view.items.map((item) => formatBotItemRow(item, now))
  return [...rows, ...(view.nextCursor ? [`More: --cursor ${view.nextCursor}`] : [])].join('\n')
}

function linkLine(link: BotItemLinkView): string {
  switch (link.kind) {
    case 'dispatch': {
      const pr = link.pr?.shown
        ? ` · PR #${link.pr.number} ${link.pr.url}`
        : link.pr
          ? ' · PR not shown for server work yet'
          : ''
      const report = link.report ? `\n    report: ${link.report.subject}` : ''
      return `dispatch:${link.ref}${link.latest ? ` (now ${link.latest})` : ''} · ${link.title ?? 'worker'} · ${link.state}${link.host ? ` on ${link.host}` : ''}${pr}${report}`
    }
    case 'pr':
      return link.pr?.shown ? `pr:${link.ref} · ${link.pr.url}` : `pr:${link.ref}`
    case 'url':
    case 'file':
      return `${link.kind}:${link.ref}`
    case 'automation':
      return `automation:${link.ref} · ${link.name ?? 'automation'} · ${link.active ? 'on' : 'gone or off'}`
  }
}

function eventLine(event: BotItemEvent): string {
  const who = event.actor.kind === 'bot' ? '' : event.actor.kind === 'owner' ? 'Owner: ' : 'Orca: '
  const data = event.data
  const words = (() => {
    switch (event.kind) {
      case 'made':
        return `made "${String(data.title ?? '')}"`
      case 'edited':
        return `edited ${Object.keys(typeof data.fields === 'object' && data.fields ? data.fields : {}).join(', ')}${data.note ? ` (${String(data.note)})` : ''}`
      case 'status':
        return `${statusWord(data.from)} → ${statusWord(data.to)}${data.note ? `: ${String(data.note)}` : ''}`
      case 'commented': {
        const images = botItemCommentImages(data).map(({ path }) => path)
        return `${String(data.text ?? '')}${images.length > 0 ? `\n    images: ${images.join(', ')}` : ''}`
      }
      case 'linked':
        return `linked ${Array.isArray(data.links) ? data.links.join(', ') : ''}`
      case 'snoozed':
        return typeof data.until === 'number'
          ? `snoozed until ${formatSnoozeTime(data.until)}`
          : 'snoozed'
      case 'unsnoozed':
        return data.early ? 'back from snooze early' : 'unsnoozed'
    }
  })()
  return `${event.id}  ${who}${words}`
}

export function formatBotItemShow(view: BotItemShowView, now = Date.now()): string {
  const { item } = view
  const until = snoozedUntil(item, now)
  const lines = [
    `item ${item.number} · ${STATUS_WORDS[item.status]} · ${titleLine(item)} · ${chatWords(item)} · owner ${item.owner.name ?? item.owner.botId}`,
    ...(until ? [`Snoozed ${snoozedWords(until)}.`] : []),
    ...(item.description ? [item.description] : []),
    ...(item.doneMeans ? [`Done means: ${item.doneMeans}`] : []),
    ...(item.question ? [`Asks your owner: ${item.question.text}`] : []),
    ...(item.wait ? [`Waits on: ${item.wait.text}`] : []),
    ...(item.closeNote ? [`Closed: ${item.closeNote}`] : []),
    ...item.links.map((link) => `  ${linkLine(link)}`),
    '',
    ...view.events.map(eventLine),
    ...(view.nextCursor ? [`More: --after ${view.nextCursor}`] : [])
  ]
  return lines.join('\n')
}
