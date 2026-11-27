// Every paired computer's bots, and its relayed servers', as one list: Home's Bots tab and Feed's section.
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import type { BotGroup } from '../../../../src/shared/bots/bot-group'
import type { BotComputerAnswer } from '../../bots/bot-link-host-reads'
import { botHomeWorktreeId, hostBotsKey } from '../../bots/host-bots-read'
import type { Translate } from '../../i18n/mobile-i18n'
import { pairedNewBotComputers, type NewBotComputer } from '../../bots/new-bot-computers'
import type { KeptComputerBots } from '../../bots/kept-computer-bots'
import {
  bestHomeRoutes,
  foldComputerRead,
  keptComputerEntries,
  type HomeComputerEntry
} from './home-computer-record'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { HomeAgentEntry, HostWorktreeInfo } from '../../worktree/catalog/home-worktree-info'
import type { HomeComputerBots } from './home-bots-query'
import {
  agentsByHome,
  botRow,
  workersByHome,
  groupRow,
  keptRows,
  NO_AGENTS,
  placeKey,
  type HomeBotRow,
  type Place
} from './home-bot-row-views'

export type { HomeBotRow } from './home-bot-row-views'

export type HomeBots = {
  rows: readonly HomeBotRow[]
  /** The Bots tab's badge. */
  needsYou: number
  /** Every computer Home knows, a server two computers relay once, in Home's order, with how its
   *  answer is held: Runs on lists each, and only a live one takes a new bot. */
  computers: readonly HomeComputerEntry[]
  /** Each computer's name by its key: a paired computer's own, or its server's. */
  labels: ReadonlyMap<string, string>
  /** Each computer that lists no bots here, and why. */
  unavailable: readonly HomeBotsUnavailable[]
  /** Some computer lists its bots, even none. */
  listable: boolean
  /** A computer that may answer hasn't yet, and nothing is kept for it. */
  awaiting: boolean
  /** Each live computer's rows' last activity, by row key: what its kept copy dates dimmed rows by. */
  activityByHost: ReadonlyMap<string, Readonly<Record<string, number>>>
}

export type HomeBotRowsInput = {
  /** Paired computers in Home's order. */
  hosts: readonly { id: string; name: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  /** Paired computers that answer nothing until something changes, as their Home rows say. */
  unreachableHosts: ReadonlySet<string>
  botsByHost: Readonly<Record<string, HomeComputerBots | undefined>>
  /** Paired computers whose read came after their latest connect. */
  freshHosts: ReadonlySet<string>
  /** Each paired computer's last answers, from this launch or the device. */
  kept: Readonly<Record<string, KeptComputerBots | undefined>>
  /** Paired computers whose kept answers have been read off the device (or found missing). */
  hydrated: ReadonlySet<string>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  now: number
  t: Translate
}

/** Needs you first, then the most recent; name and key keep equal rows in place. */
export function compareHomeBotRows(a: HomeBotRow, b: HomeBotRow): number {
  return (
    Number(b.needsYou > 0) - Number(a.needsYou > 0) ||
    b.activityAt - a.activityAt ||
    a.title.localeCompare(b.title) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
}

/** Why a computer lists no bots on Home, for the Bots tab's lines. */
export type HomeBotsUnavailable = {
  key: string
  label: string
  reason: 'update' | 'off' | 'unreachable'
  /** A server's paired computer, whose Settings hold its Bots switch. */
  desktopLabel?: string
}

const succeeded = (entry: HomeComputerEntry): boolean =>
  entry.answer.kind === 'bots' || entry.answer.kind === 'no-capability'

/** A paired computer with no answer yet and nothing kept: Runs on still lists it, disabled. */
function placeholder(pairedHostId: string, mode: 'pending' | 'offline'): HomeComputerEntry {
  return {
    key: hostBotsKey(pairedHostId),
    pairedHostId,
    executionHost: LOCAL_EXECUTION_HOST_ID,
    readAt: 0,
    answer: { kind: mode === 'offline' ? 'unreachable' : 'unreadable' },
    mode
  }
}

const isOwnEntry = (entry: HomeComputerEntry): boolean =>
  entry.key === hostBotsKey(entry.pairedHostId)

/** Every paired computer's bots and rooms once each, a server two computers relay listed once. A
 *  computer without a fresh read shows its kept one: as it was while it may answer again, dimmed while it
 *  is offline, and never with Needs you counts. */
export function homeBotRows(input: HomeBotRowsInput): HomeBots {
  const names = new Map(input.hosts.map((host) => [host.id, host.name]))
  const unavailable: HomeBotsUnavailable[] = []
  let awaiting = false
  const all: HomeComputerEntry[] = []
  const placeholders = new Set<HomeComputerEntry>()
  const holdPlace = (hostId: string, mode: 'pending' | 'offline') => {
    const entry = placeholder(hostId, mode)
    placeholders.add(entry)
    all.push(entry)
  }
  const groupsOf = new Map<string, readonly BotGroup[]>()
  for (const host of input.hosts) {
    const offline = input.unreachableHosts.has(host.id)
    const read = input.botsByHost[host.id]
    const last = input.kept[host.id]
    const hydrated = input.hydrated.has(host.id)
    const start = all.length
    if (input.hostStates[host.id] === 'connected' && read && input.freshHosts.has(host.id)) {
      const folded = foldComputerRead(host.id, last, read)
      // Until the device copy is in, a failed answer may yet have a kept one: show only good ones, and wait.
      all.push(...(hydrated ? folded.entries : folded.entries.filter(succeeded)))
      groupsOf.set(host.id, folded.groups)
      awaiting ||= !hydrated
    } else if (last) {
      all.push(...keptComputerEntries(last, offline ? 'offline' : 'pending'))
      groupsOf.set(host.id, last.groups)
    }
    // No answer of its own to show (none yet, a failed first read, an empty kept copy): Runs on still
    // lists the computer, Offline while it is down and Checking… while it may answer.
    if (!all.slice(start).some(isOwnEntry)) {
      const settled = offline && hydrated
      if (settled) {
        unavailable.push({ key: host.id, label: host.name, reason: 'unreachable' })
      } else {
        awaiting = true
      }
      holdPlace(host.id, settled ? 'offline' : 'pending')
    }
  }
  // A paired computer's Bots switch off hides its servers too, as on the desktop: in the list, Runs on and
  // +. Applied before routes are chosen, so a server another computer relays keeps that route.
  const switchedOff = new Set(
    all.flatMap((entry) =>
      isOwnEntry(entry) && entry.answer.kind === 'bots' && !entry.answer.enabled
        ? [entry.pairedHostId]
        : []
    )
  )
  const eligible = all.filter(
    (entry) =>
      entry.executionHost === LOCAL_EXECUTION_HOST_ID || !switchedOff.has(entry.pairedHostId)
  )
  const entries = bestHomeRoutes(eligible)
  const homesByHost = new Map<string, Map<string, HomeAgentEntry[]>>()
  const homesOf = (pairedHostId: string) => {
    let homes = homesByHost.get(pairedHostId)
    if (!homes) {
      homes = agentsByHome(input.worktreeInfo[pairedHostId])
      homesByHost.set(pairedHostId, homes)
    }
    return homes
  }
  const labels = new Map<string, string>()
  const rows: HomeBotRow[] = []
  const activityByHost = new Map<string, Record<string, number>>()
  let listable = false
  for (const entry of entries) {
    const { pairedHostId, answer } = entry
    const own = entry.executionHost === LOCAL_EXECUTION_HOST_ID
    const hostLabel = own ? (names.get(pairedHostId) ?? '') : (entry.serverLabel ?? '')
    labels.set(entry.key, hostLabel)
    // A computer with no answer yet and nothing kept lists nothing; Runs on shows it, disabled.
    if (placeholders.has(entry)) {
      continue
    }
    const why = (reason: HomeBotsUnavailable['reason']) =>
      unavailable.push({
        key: entry.key,
        label: hostLabel,
        reason,
        ...(own ? {} : { desktopLabel: names.get(pairedHostId) ?? '' })
      })
    if (answer.kind === 'no-capability') {
      why('update')
      continue
    }
    if (answer.kind === 'unreachable') {
      why('unreachable')
      continue
    }
    if (answer.kind !== 'bots') {
      continue
    }
    if (!answer.enabled) {
      why('off')
      continue
    }
    listable = true
    const place: Place = {
      placeKey: placeKey(entry),
      computerKey: entry.key,
      pairedHostId,
      executionHost: entry.executionHost,
      hostLabel
    }
    // A room opens through its paired computer only, as on that computer's Bots list.
    const groups = own ? (groupsOf.get(pairedHostId) ?? []) : []
    const first = rows.length
    if (entry.mode !== 'live') {
      const lastActivity = input.kept[pairedHostId]?.lastActivity ?? {}
      rows.push(...keptRows(place, answer, entry.mode, groups, lastActivity, input.now, input.t))
    } else {
      const homes = homesOf(pairedHostId)
      const workersOf = own ? workersByHome(input.worktreeInfo[pairedHostId]) : null
      const access = input.botsByHost[pairedHostId]?.accessRequests[entry.key] ?? []
      for (const bot of answer.bots) {
        const home = botHomeWorktreeId(bot)
        rows.push(
          botRow(
            place,
            answer,
            bot,
            homes.get(home) ?? NO_AGENTS,
            input.now,
            { workers: workersOf?.(home), access },
            input.t
          )
        )
      }
      if (groups.length > 0) {
        const byPane = new Map(
          [...homes.values()].flat().map((home) => [home.agent.paneKey, home.agent])
        )
        // A member's finished reply marks the room's hidden home unread, as on the computer's list.
        const unread = new Set(input.worktreeInfo[pairedHostId]?.unreadWorktreeIds ?? [])
        for (const group of groups) {
          rows.push(
            groupRow(
              place,
              group,
              answer.bots,
              (paneKey) => byPane.get(paneKey),
              unread.has(botHomeWorktreeId(group)),
              input.now,
              input.t
            )
          )
        }
      }
    }
    // Kept rows too: a computer's next kept copy dates its offline servers' bots as they were.
    let activity = activityByHost.get(pairedHostId)
    if (!activity) {
      activity = {}
      activityByHost.set(pairedHostId, activity)
    }
    for (const row of rows.slice(first)) {
      if (row.activityAt > 0) {
        activity[row.key] = row.activityAt
      }
    }
  }
  rows.sort(compareHomeBotRows)
  return {
    rows,
    needsYou: rows.reduce((sum, row) => sum + row.needsYou, 0),
    computers: entries,
    labels,
    unavailable,
    listable,
    awaiting,
    activityByHost
  }
}

/** Runs on from Home: every computer Home knows. One without a live answer stays listed, "Checking…"
 *  while it may answer and "Offline" while it is down, and takes no bot until it answers. */
export function homeNewBotComputers(bots: HomeBots, t: Translate): NewBotComputer[] {
  const asAnswered = bots.computers.map((computer): BotComputerAnswer =>
    computer.mode === 'live'
      ? computer
      : {
          ...computer,
          answer: { kind: computer.mode === 'offline' ? 'unreachable' : 'unreadable' }
        }
  )
  return pairedNewBotComputers(asAnswered, (computer) => bots.labels.get(computer.key) ?? '', t)
}
