import { useSyncExternalStore } from 'react'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import type { ConnectorCloudStatus } from '../../../src/shared/bots/connector-cloud-status'
import type { PhoneBot } from './host-bots-operations'

// Every screen reads a host's bots from here, so the list, a link and a bot's sheet show one answer.
type HostBotsEntry = {
  bots: readonly PhoneBot[]
  hideBotCreated: boolean
  /** The status the host list rolled up for each bot, which its header shows too. */
  statusByBotId: ReadonlyMap<string, BotRowStatus>
  /** Each bot's Needs you items that aren't stale, by bot id; empty from an older host. */
  needsYou: Readonly<Record<string, number>>
  /** This host's Orca Cloud link. A list that omits it clears a status kept from an older read. */
  connectorStatus?: ConnectorCloudStatus
  /** Its Orca Cloud answers an event in that event's thread; false from an older host. */
  threadReplies: boolean
}

const entries = new Map<string, HostBotsEntry>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishHostBots(
  key: string,
  read: Pick<HostBotsEntry, 'bots' | 'hideBotCreated'> &
    Partial<Pick<HostBotsEntry, 'needsYou' | 'connectorStatus' | 'threadReplies'>>
): void {
  const { bots, hideBotCreated, needsYou = {}, connectorStatus, threadReplies = false } = read
  entries.set(key, {
    bots,
    hideBotCreated,
    needsYou,
    connectorStatus,
    threadReplies,
    statusByBotId: entries.get(key)?.statusByBotId ?? new Map()
  })
  notify()
}

/** Takes a host's reply to an edit, so every screen shows it before the next read. */
export function publishHostBot(key: string, bot: PhoneBot): void {
  const entry = entries.get(key)
  if (!entry) {
    return
  }
  entries.set(key, {
    ...entry,
    bots: entry.bots.map((current) => (current.id === bot.id ? bot : current))
  })
  notify()
}

export function publishHostBotStatuses(
  key: string,
  statusByBotId: ReadonlyMap<string, BotRowStatus>
): void {
  const entry = entries.get(key)
  const previous = entry?.statusByBotId
  if (
    !entry ||
    (previous?.size === statusByBotId.size &&
      [...statusByBotId].every(([botId, status]) => previous.get(botId) === status))
  ) {
    return
  }
  entries.set(key, { ...entry, statusByBotId })
  notify()
}

export function useHostBotsEntry(key: string | null): HostBotsEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key) ?? null) : null),
    () => null
  )
}

function botById(botId: string): PhoneBot | null {
  for (const entry of entries.values()) {
    const bot = entry.bots.find((candidate) => candidate.id === botId)
    if (bot) {
      return bot
    }
  }
  return null
}

/** A bot by id from whichever host listed it; null until a list holding it has been read. */
export function useHostBotById(botId: string): PhoneBot | null {
  return useSyncExternalStore(
    subscribe,
    () => botById(botId),
    () => null
  )
}

function statusOf(botId: string): BotRowStatus | null {
  for (const entry of entries.values()) {
    const status = entry.statusByBotId.get(botId)
    if (status) {
      return status
    }
  }
  return null
}

/** A bot's rolled-up row status from whichever host listed it; null until a list has drawn it. */
export function useHostBotStatus(botId: string): BotRowStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => statusOf(botId),
    () => null
  )
}
