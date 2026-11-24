// One Home row per bot or room: drawn live from its computer's answer, or kept from its last one.
import type { BotGroup } from '../../../../src/shared/bots/bot-group-schema'
import { botGroupStatusOf } from '../../../../src/shared/bots/bot-group-status'
import { foldBotStatus, type BotRowStatus } from '../../../../src/shared/bots/bot-row-status'
import {
  botGroupMemberBots,
  botGroupRowLine
} from '../../../../src/shared/bots/bot-sidebar-entries'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import type { BotRowLine } from '../../../../src/shared/bots/bot-row-line'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { WorktreeStatus } from '../../../../src/shared/worktree/row-display/worktree-status-rollup'
import { agentStatusGroup, listedAgentVerdict } from '../../agents/agent-list-rows'
import type { BotComputerAnswer } from '../../bots/bot-link-host-reads'
import { mobileBotAvatarSource, type MobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import type { PhoneBot } from '../../bots/host-bots-operations'
import {
  mobileBotRowLine,
  mobileBotRowLineText,
  mobileBotRowNeedsYou
} from '../../bots/mobile-bot-row-line'
import { translate } from '../../i18n/mobile-i18n'
import {
  agentDotState,
  agentRowTimeAt,
  formatTimeAgo
} from '../../worktree/agent-lineage/agent-row-display'
import type { HomeAgentEntry, HostWorktreeInfo } from '../../worktree/catalog/home-worktree-info'
import type { BotWorkspaceLiveCounts } from '../../../../src/shared/bots/bot-sidebar-workspaces'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { hostBotWorkerCounts, lazyHostBotLineage } from '../../bots/host-bot-worker-lines'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { resolveWorktreeHostId } from '../../worktree/row-presentation/worktree-host-context-labels'

export type HomeRowBase = {
  /** Unique across computers, and the same whichever computer relays a server's bot. */
  key: string
  /** `hostBotsKey` of the paired computer and the computer it runs on: the route this read took. */
  computerKey: string
  pairedHostId: string
  executionHost: ExecutionHostId
  hostLabel: string
  title: string
  preview: string
  age: string | null
  unread: boolean
  /** Its Needs you count (`mobileBotRowNeedsYou`), from the facts its computer's Bots list counts:
   *  its asks, its workers', its items and the people asking. The Bots badge sums these, and they sort
   *  it first. */
  needsYou: number
  activityAt: number
  /** Kept from before its computer went offline: dimmed, and tapping it says so. */
  offline?: true
}

/** A bot, or a group room as the computer's Bots list shows it among its bots. */
export type HomeBotRow =
  | (HomeRowBase & {
      kind: 'bot'
      bot: PhoneBot
      dot: BotRowStatus | null
      /** What `preview` says, which a usage-limit stop takes the place of while it is quiet. */
      line: BotRowLine | null
    })
  | (HomeRowBase & {
      /** An agent shared with the computer's account, reached over this phone's own link. */
      kind: 'shared'
      environmentId: string
      avatar: MobileBotAvatarSource
      /** Grey while its owner's computer is away; none while it is reached. */
      dot: BotRowStatus | null
    })
  | (HomeRowBase & {
      kind: 'group'
      group: BotGroup
      faces: readonly { id: string; name: string; avatar: MobileBotAvatarSource }[]
      dot: ReturnType<typeof botGroupStatusOf>
    })

export const NO_AGENTS: readonly HomeAgentEntry[] = []

/** One paired computer's live agents by worktree id; a relayed server's bot homes are among them. */
export function agentsByHome(info: HostWorktreeInfo | undefined): Map<string, HomeAgentEntry[]> {
  const byHome = new Map<string, HomeAgentEntry[]>()
  for (const entry of info?.agents ?? NO_AGENTS) {
    const list = byHome.get(entry.worktreeId) ?? []
    list.push(entry)
    byHome.set(entry.worktreeId, list)
  }
  return byHome
}

const NO_REPO_HOSTS: ReadonlyMap<string, ExecutionHostId> = new Map()

/** One paired computer's bots' own workers' counts by home worktree id, from Home's worktree read:
 *  its own rows only, so a relayed server's bot, and a worker on a server, count none here. */
export function workersByHome(
  info: HostWorktreeInfo | undefined
): (homeWorktreeId: string) => BotWorkspaceLiveCounts | undefined {
  const rows = info?.rows ?? []
  const hostOf = (row: Worktree) => resolveWorktreeHostId(row, NO_REPO_HOSTS)
  const homes = new Map(
    rows.flatMap((row) => (hostOf(row) === LOCAL_EXECUTION_HOST_ID ? [[row.worktreeId, row]] : []))
  )
  const lineageOf = lazyHostBotLineage(
    rows,
    undefined,
    hostOf,
    new Map([[LOCAL_EXECUTION_HOST_ID, info?.workspaceLineage ?? {}]])
  )
  return (homeWorktreeId) => {
    const home = homes.get(homeWorktreeId)
    return home && hostBotWorkerCounts(home, lineageOf())
  }
}

/** The bot's own turn, folded as on its computer's Bots list: needs you, working, else available or paused. */
function botDot(agents: readonly HomeAgentEntry[], paused: boolean, now: number): BotRowStatus {
  let status: WorktreeStatus = 'inactive'
  for (const { agent } of agents) {
    const group = agentStatusGroup(agentDotState(agent, now))
    if (group === 'needs-you') {
      return 'permission'
    }
    if (group === 'working') {
      status = 'working'
    }
  }
  return foldBotStatus(status, paused)
}

/** Where a row runs, kept apart from which paired computer reached it. */
export function placeKey(computer: BotComputerAnswer): string {
  return computer.executionHost !== LOCAL_EXECUTION_HOST_ID && computer.installationId
    ? `install:${computer.installationId}`
    : computer.key
}

export type Place = Pick<
  HomeRowBase,
  'computerKey' | 'pairedHostId' | 'executionHost' | 'hostLabel'
> & {
  placeKey: string
}

export function botRow(
  place: Place,
  answer: Extract<BotComputerAnswer['answer'], { kind: 'bots' }>,
  bot: PhoneBot,
  agents: readonly HomeAgentEntry[],
  now: number,
  /** Its workers and the people asking for access, as its computer's Bots list reads them. */
  asks: { workers?: BotWorkspaceLiveCounts; access: readonly ConnectorAccessRequest[] }
): HomeBotRow {
  const access = asks.access.filter((request) => request.botId === bot.id).length
  const facts = {
    paused: bot.paused,
    line: {
      chatSessionId: bot.chatSessionId ?? null,
      links: [],
      waits: answer.waits[bot.id] ?? [],
      ...(asks.workers ? { workers: asks.workers } : {}),
      itemsNeedingYou: (answer.needsYou[bot.id] ?? 0) + access
    }
  }
  const rows = agents.map((entry) => entry.agent)
  const line = mobileBotRowLine(facts, rows, now)
  const lineAt = line?.kind === 'activity' ? line.at : null
  return {
    kind: 'bot',
    key: `${place.placeKey}\nbot:${bot.id}`,
    computerKey: place.computerKey,
    pairedHostId: place.pairedHostId,
    executionHost: place.executionHost,
    hostLabel: place.hostLabel,
    title: bot.name,
    bot,
    dot: botDot(agents, bot.paused, now),
    line,
    preview: line ? mobileBotRowLineText(line, now) : '',
    age: lineAt === null ? null : formatTimeAgo(lineAt, now),
    unread: agents.some((entry) => listedAgentVerdict(entry.agent)?.unread === true),
    needsYou: mobileBotRowNeedsYou(facts.line, rows, now),
    activityAt: Math.max(lineAt ?? 0, ...rows.map(agentRowTimeAt))
  }
}

export function groupRow(
  place: Place,
  group: BotGroup,
  bots: readonly PhoneBot[],
  agentOf: (paneKey: string) => RuntimeWorktreeAgentRow | undefined,
  unread: boolean,
  now: number
): HomeBotRow {
  const faces = botGroupMemberBots(group, bots).map((bot) => ({
    id: bot.id,
    name: bot.name,
    avatar: mobileBotAvatarSource(bot)
  }))
  const line = botGroupRowLine(group, faces, translate('bots.groups.you', 'You'))
  return {
    kind: 'group',
    key: `${place.placeKey}\ngroup:${group.id}`,
    computerKey: place.computerKey,
    pairedHostId: place.pairedHostId,
    executionHost: place.executionHost,
    hostLabel: place.hostLabel,
    title: group.name,
    group,
    faces,
    dot: botGroupStatusOf(group, agentOf),
    preview: line.text,
    age: line.at === null ? null : formatTimeAgo(line.at, now),
    unread,
    needsYou: 0,
    activityAt: line.at ?? 0
  }
}

/** A computer's kept bots and rooms: no dot, no line and no Needs you; offline, dimmed with how long
 *  ago each was last active. */
export function keptRows(
  place: Place,
  answer: Extract<BotComputerAnswer['answer'], { kind: 'bots' }>,
  mode: 'pending' | 'offline',
  groups: readonly BotGroup[],
  lastActivity: Readonly<Record<string, number>>,
  now: number
): HomeBotRow[] {
  const offline = mode === 'offline'
  const kept = (key: string, title: string) => {
    const at = lastActivity[key] ?? 0
    return {
      key,
      computerKey: place.computerKey,
      pairedHostId: place.pairedHostId,
      executionHost: place.executionHost,
      hostLabel: place.hostLabel,
      title,
      preview: '',
      age: offline && at > 0 ? formatTimeAgo(at, now) : null,
      unread: false,
      needsYou: 0,
      activityAt: at,
      ...(offline ? { offline: true as const } : {})
    }
  }
  const bots = answer.bots
  return [
    ...bots.map((bot): HomeBotRow => ({
      ...kept(`${place.placeKey}\nbot:${bot.id}`, bot.name),
      kind: 'bot',
      bot,
      dot: null,
      line: null
    })),
    ...groups.map((group): HomeBotRow => ({
      ...kept(`${place.placeKey}\ngroup:${group.id}`, group.name),
      kind: 'group',
      group,
      faces: botGroupMemberBots(group, bots).map((bot) => ({
        id: bot.id,
        name: bot.name,
        avatar: mobileBotAvatarSource(bot)
      })),
      dot: null
    }))
  ]
}
