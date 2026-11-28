// The one reader of this host's Request access asks, and the host's store of them: it tells the owner of
// new ones through the bot owner notice, serves bots.access.list from its last read, and tells windows and phones, through
// botsChanged, to re-read that. The cloud lists requests per account; each host announces only its own
// bots', and keeps on disk how far it has announced.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accessRequestPerson, botAccessRequestNoticeId } from '../../shared/bots/bot-access-request'
import { botHasConnector } from '../../shared/bot-types'
import type { ConnectorAccessRequest } from '../../shared/connector-bot-access-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import { CONNECTOR_SOURCE_NAMES } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import type { OwnerNotice } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { listHostAccessRequests, type BotAccessHostDeps } from './bot-access-host'
import { chatPaneKey } from '../../shared/agent-session/view/structured-agent-session-projection'
import { botOwnerNoticeText } from './bot-owner-notice-copy'

export const BOT_ACCESS_WATCH_INTERVAL_MS = 5 * 60_000

const SEEN_FILE = 'bot-access-requests-seen.json'

// Cloud servers' clocks can disagree, so a request may be saved after a newer-stamped one was read.
export const BOT_ACCESS_LOOKBACK_MS = 5 * 60_000
// Far above the cloud's newest-100 list within a lookback; a record past it is not one this host wrote.
const MAX_RECENT = 500
const MAX_REQUEST_ID_LENGTH = 128

/**
 * How far this host has announced: the newest createdAt it announced, and each id it announced within
 * the lookback before that, with its createdAt. Anything older than the lookback is old, so a request
 * that leaves the cloud's capped list and comes back is never new again, and the record stays small.
 */
export type BotAccessSeen = { through: number; recent: [requestId: string, createdAt: number][] }

export type BotAccessSeenStore = {
  /** Null before the first read on this profile, or when the record is unreadable. */
  read(): BotAccessSeen | null
  write(seen: BotAccessSeen): void
}

export type BotAccessWatchDeps = BotAccessHostDeps & {
  botsEnabled: () => boolean
  /** The bots' owner notice; windows toast requests themselves. */
  notify: (notice: OwnerNotice) => void
  /** The waiting list changed; windows and phones showing it re-read it. */
  changed: () => void
  seen: BotAccessSeenStore
  now: () => number
}

function requestNotice(
  request: ConnectorAccessRequest,
  botName: string,
  folderWorkspaceId: string,
  chatSessionId: string | null
): OwnerNotice {
  return {
    id: botAccessRequestNoticeId(request.requestId),
    title: botOwnerNoticeText('accessAsked', {
      person: accessRequestPerson(request),
      bot: botName
    }),
    body: [CONNECTOR_SOURCE_NAMES[request.source], request.workspaceName]
      .filter(Boolean)
      .join(' · '),
    // A phone's tap opens the bot's Home Chat and the request's decision there.
    worktreeId: folderWorkspaceKey(folderWorkspaceId),
    ...(chatSessionId ? { paneKey: chatPaneKey(chatSessionId) } : {}),
    desktop: false
  }
}

function isNew(request: ConnectorAccessRequest, seen: BotAccessSeen): boolean {
  return (
    request.createdAt > seen.through - BOT_ACCESS_LOOKBACK_MS &&
    !seen.recent.some(([id]) => id === request.requestId)
  )
}

/**
 * Moves the mark to the newest of `requests` and keeps only ids inside the lookback from it. A stamp
 * past the host's clock moves the mark no further than the lookback, so a bad one can't hide what follows.
 */
function advance(
  seen: BotAccessSeen,
  requests: readonly ConnectorAccessRequest[],
  now: number
): BotAccessSeen {
  let through = seen.through
  for (const request of requests) {
    through = Math.max(through, Math.min(request.createdAt, now + BOT_ACCESS_LOOKBACK_MS))
  }
  const recent: BotAccessSeen['recent'] = [
    ...seen.recent,
    ...requests.map((request): [string, number] => [request.requestId, request.createdAt])
  ]
  return {
    through,
    recent: recent
      .filter(([, createdAt]) => createdAt > through - BOT_ACCESS_LOOKBACK_MS)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_RECENT)
  }
}

/** A mark this host could have written: a whole epoch time, not past its own clock's lookback. */
function plausible(seen: BotAccessSeen | null, now: number): BotAccessSeen | null {
  return seen && Number.isSafeInteger(seen.through) && seen.through <= now + BOT_ACCESS_LOOKBACK_MS
    ? seen
    : null
}

function uniqueById(requests: readonly ConnectorAccessRequest[]): ConnectorAccessRequest[] {
  const ids = new Set<string>()
  return requests.filter((request) => !ids.has(request.requestId) && ids.add(request.requestId))
}

/**
 * Reads are serialized. The mark moves past fresh requests, in memory and on disk, before anything is
 * sent, so a crash after a save skips an announcement rather than repeating it. A failed save keeps
 * the mark in memory and is retried on the next read; only a restart while saves keep failing loses
 * it, which announces each of those requests once more.
 */
export type BotAccessRequestWatch = ReturnType<typeof createBotAccessRequestWatch>

export function createBotAccessRequestWatch(deps: BotAccessWatchDeps) {
  // The last read's answer: its list, or signed out. A failed read keeps the list before it.
  let last: BotSlackResult<ConnectorAccessRequest[]> | null = null
  let seen: BotAccessSeen | null = null
  let unsaved = false
  let running: Promise<void> | null = null
  // The ids last listed, so a read that finds the same list tells no one.
  let listedIds = ''

  const tellIfChanged = (requests: readonly ConnectorAccessRequest[]): void => {
    const ids = requests
      .map((request) => request.requestId)
      .sort()
      .join('\n')
    if (ids !== listedIds) {
      listedIds = ids
      deps.changed()
    }
  }

  const save = (): void => {
    if (!seen) {
      return
    }
    try {
      deps.seen.write(seen)
      unsaved = false
    } catch (error) {
      unsaved = true
      console.warn('[bots] could not save which access requests were announced', error)
    }
  }

  const read = async (): Promise<void> => {
    // Requests come from a connector's people, so a host without a bot on one has none to read.
    if (!deps.botsEnabled() || !deps.bots().some(botHasConnector)) {
      // Requests read while a connector was on aren't actionable without one.
      if (last) {
        last = null
        tellIfChanged([])
      }
      return
    }
    const listed = await listHostAccessRequests(deps)
    if (listed.ok || listed.error === 'signed_out' || !last) {
      last = listed
    }
    if (!listed.ok) {
      // Another account's requests must not stay actionable here.
      if (listed.error === 'signed_out') {
        tellIfChanged([])
      }
      return
    }
    const now = deps.now()
    const firstRead = seen === null
    const known = seen ?? plausible(deps.seen.read(), now)
    // The first read on a profile, or after an implausible record, only marks what waits: no backlog.
    const announce = known !== null
    const listedOnce = uniqueById(listed.value)
    const fresh = known ? listedOnce.filter((request) => isNew(request, known)) : listedOnce
    seen = advance(known ?? { through: 0, recent: [] }, fresh, now)
    if (fresh.length > 0 || unsaved || firstRead) {
      save()
    }
    const announced = announce ? fresh : []
    const bots = deps.bots()
    for (const request of announced) {
      const bot = bots.find((entry) => entry.id === request.botId)
      if (bot) {
        deps.notify(requestNotice(request, bot.name, bot.folderWorkspaceId, bot.chatSessionId))
      }
    }
    tellIfChanged(listed.value)
  }

  /** One read at a time; a read asked for while one runs joins it. */
  const tick = (): Promise<void> => {
    running ??= read()
      .catch((error: unknown) => {
        console.warn('[bots] could not check access requests', error)
      })
      .finally(() => {
        running = null
      })
    return running
  }

  return {
    tick,
    /** Drops an answered request from the store at once, then reads the cloud after any running read. */
    answered: (requestId: string): Promise<void> => {
      if (last?.ok) {
        last = { ok: true, value: last.value.filter((request) => request.requestId !== requestId) }
        tellIfChanged(last.value)
      }
      return (running ?? Promise.resolve()).then(tick)
    },
    /** The last read's answer; the cloud is read only before there is one. */
    list: async (): Promise<BotSlackResult<ConnectorAccessRequest[]>> => {
      if (!last) {
        await tick()
      }
      if (last) {
        return last
      }
      // No bot on a connector: no request can be this host's, so the cloud isn't asked.
      if (!deps.bots().some(botHasConnector)) {
        return { ok: true, value: [] }
      }
      // Bots off: the watch doesn't read, so this asks the cloud itself.
      return listHostAccessRequests(deps)
    },
    /** Reads now, then on the interval; stops with the returned function. */
    start: (): (() => void) => {
      void tick()
      const timer = setInterval(() => void tick(), BOT_ACCESS_WATCH_INTERVAL_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }
  }
}

export function botAccessSeenFile(userDataPath: string): BotAccessSeenStore {
  const path = join(userDataPath, SEEN_FILE)
  return {
    read: () => {
      if (!existsSync(path)) {
        return null
      }
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || !('through' in parsed)) {
          return null
        }
        const { through } = parsed
        const recent = 'recent' in parsed ? parsed.recent : null
        if (typeof through !== 'number' || !Array.isArray(recent) || recent.length > MAX_RECENT) {
          return null
        }
        const entries = recent.flatMap((entry: unknown): [string, number][] =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          entry[0].length <= MAX_REQUEST_ID_LENGTH &&
          typeof entry[1] === 'number'
            ? [[entry[0], entry[1]]]
            : []
        )
        // One bad entry means this host didn't write it.
        return entries.length === recent.length ? { through, recent: entries } : null
      } catch {
        // Unreadable: announce nothing old again; the next read marks what waits.
        return null
      }
    },
    write: (seen) => writeFileAtomically(path, JSON.stringify(seen), { mode: 0o600 })
  }
}
