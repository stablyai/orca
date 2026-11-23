import {
  botPreviewFacts,
  botStatusNeedsAttention
} from '../../../src/shared/bots/bot-collapsed-preview'
import { translate } from '../i18n/mobile-i18n'
import { accessRequestPerson } from '../../../src/shared/bots/bot-access-request'
import { getBotSidebarEntries } from '../../../src/shared/bots/bot-sidebar-entries'
import type { BotSidebarEntryActivity } from '../../../src/shared/bots/bot-sidebar-view'
import { foldBotStatus, type BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import {
  botFoldLiveStatus,
  countLiveBotWorkspaces
} from '../../../src/shared/bots/bot-sidebar-workspaces'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { parseWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import { getWorktreeDotStatus } from '../worktree/workspace-list/workspace-list-ordering'
import type {
  Section,
  WorkspaceListItem,
  Worktree
} from '../worktree/workspace-list/workspace-list-types'
import { resolveWorktreeHostId } from '../worktree/row-presentation/worktree-host-context-labels'
import type { MobileLineageStores } from '../worktree/agent-lineage/mobile-workspace-lineage'
import { botStatusLine, mobileBotAvatarSource } from './host-bot-row-facts'
import type { ListedHostBots, HostBotListing } from './host-bot-listing'
import { hostAgentsByPaneKey, hostBotGroupRow } from './host-bot-group-row'
import { hostBotWorkerLines, type lazyHostBotLineage } from './host-bot-worker-lines'
import type { BotChatFold } from '../../../src/shared/bots/bot-chat-tree'
import { hostBotChatItems } from './host-bot-chat-items'
import { hostBotFoldKey } from './host-bot-fold-key'
import { botListsUnderRow } from '../../../src/shared/bots/bot-sidebar-tree'
import { hostBotsKey } from './host-bots-read'
import { hostBotTreeKey, type HostBotChatTrees } from './bot-chat-tree-reads'

export type HostBotSectionInputs = {
  /** Every live row on the host page, unfiltered, so a bot's lines show whatever the filters hide. */
  rows: readonly Worktree[]
  listings: readonly HostBotListing[]
  collapsedGroups: ReadonlySet<string>
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  search: string
  /** How the list draws a row, e.g. this phone's highlight. */
  drawRow: (row: Worktree) => WorkspaceListItem
  lineageStores?: MobileLineageStores
  /** The paired host's route id, which each host's chat folds are kept under (`hostBotsKey`). */
  pairedHostId: string
  /** Each unfolded bot's chats; a bot with none read lists its workspaces flat. */
  chatTrees: HostBotChatTrees
  /** This phone's chat folds and worker paging steps, by `botChatFoldKey`. */
  chatFolds: Readonly<Record<string, BotChatFold>>
  chatSteps: Readonly<Record<string, number>>
}

/** One bot or group of one host, drawn, before the one list arranges them. */
export type DrawnBotEntry = {
  entry:
    | { kind: 'bot'; bot: { name: string; paused: boolean } }
    | { kind: 'group'; group: { name: string } }
  items: WorkspaceListItem[]
  preview?: NonNullable<Section['botPreview']>[number]
  activity: BotSidebarEntryActivity
}

/** A host's name and down word by id, for worker lines on another computer than their bot's. */
export type BotHostNames = ReadonlyMap<ExecutionHostId, { label: string; offline?: string }>

function matches(row: Worktree, query: string): boolean {
  return row.displayName.toLowerCase().includes(query)
}

/** A worker line on a server other than its bot's names it; one on a down server dims. */
function placeWorkerLine(
  line: WorkspaceListItem,
  lineHost: ExecutionHostId,
  botHost: ExecutionHostId,
  hosts: BotHostNames
): WorkspaceListItem {
  const host = hosts.get(lineHost)
  const named =
    lineHost !== botHost && lineHost !== LOCAL_EXECUTION_HOST_ID && host
      ? { hostContextLabel: host.label, hostContextHostId: lineHost }
      : {}
  return {
    row: line.row,
    view: { ...line.view, ...named, ...(host?.offline ? { dimmed: true as const } : {}) }
  }
}

/** One host's bots and groups, drawn as rows, and every row identity they take from the projects. */
export function drawHostBotEntries(
  listing: ListedHostBots,
  hostRows: readonly Worktree[],
  inputs: HostBotSectionInputs,
  lineageOf: ReturnType<typeof lazyHostBotLineage>,
  hosts: BotHostNames
): { drawn: DrawnBotEntry[]; listed: Set<string>; total: number; shownTotal: number } {
  const shown = inputs.drawRow
  const { hostId } = listing
  const hostOf = (row: Worktree) => resolveWorktreeHostId(row, inputs.repoHostIdByRepoId)
  const identity = (row: Worktree) => composeWorktreeHostIdentity(hostOf(row), row.worktreeId)
  const folderHomes = hostRows.flatMap((row) => {
    const scope = parseWorkspaceKey(row.worktreeId)
    return row.workspaceKind === 'folder-workspace' && scope?.type === 'folder'
      ? [{ id: scope.folderWorkspaceId, executionHostId: hostId, row }]
      : []
  })
  const entries = getBotSidebarEntries(
    listing.bots.map((bot) => ({ ...bot, hostId })),
    // A room opens through the paired host only, so a relayed server's groups stay hidden, not listed.
    hostId === LOCAL_EXECUTION_HOST_ID
      ? (listing.groups ?? []).map((group) => ({ ...group, hostId }))
      : [],
    folderHomes
  )
  const agentByPaneKey = hostAgentsByPaneKey(hostRows)
  const query = inputs.search.trim().toLowerCase()
  const listed = new Set<string>()
  const drawn: DrawnBotEntry[] = []
  const offline = listing.offline
  // A server bot says where it runs; a down one says the host's word in place of its own.
  const host =
    hostId === LOCAL_EXECUTION_HOST_ID
      ? undefined
      : { id: hostId, label: listing.hostLabel, ...(offline ? { word: offline } : {}) }
  const activityAt = (rows: readonly Worktree[]): number =>
    Math.max(0, ...rows.map((row) => row.lastActivityAt ?? 0).filter(Number.isFinite))
  for (const entry of entries) {
    const { home } = entry
    listed.add(identity(home.row))
    if (entry.kind === 'group') {
      const groupRow = hostBotGroupRow({
        group: entry.group,
        drawnHome: shown(home.row),
        sectionListKey: `bot-group:${identity(home.row)}`,
        bots: listing.bots,
        agentByPaneKey
      })
      if (!query || matches(groupRow.row, query)) {
        drawn.push({
          entry,
          items: [groupRow],
          activity: {
            needsYou: botStatusNeedsAttention(getWorktreeDotStatus(home.row)),
            activityAt: Math.max(activityAt([home.row]), entry.group.latest?.at ?? 0)
          }
        })
      }
      continue
    }
    const { bot } = entry
    const { workers, allLines, lines, branches } = hostBotWorkerLines({
      listing,
      homeRow: home.row,
      lineage: lineageOf(),
      drawRow: shown,
      paused: bot.paused
    })
    if (listing.hideBotCreated) {
      allLines.forEach((line) => listed.add(identity(line.row)))
    }

    const groupKey = hostBotFoldKey(hostId, home.id)
    // The bot's own workspaces count, as on the desktop; their children only show under them.
    const own = getWorktreeDotStatus(home.row)
    const workspaceStatuses = workers.map(getWorktreeDotStatus)
    const preview = botPreviewFacts({
      own,
      workspaces: workspaceStatuses,
      homeUnread: home.row.unread,
      paused: bot.paused
    })
    const status = foldBotStatus(preview.status, bot.paused)
    const upNext = offline ? 0 : (listing.unseen?.[bot.id] ?? 0)
    const needsYou = listing.needsYou?.[bot.id] ?? 0
    // A down host's requests are its last read, so its line leaves them out.
    const access = offline
      ? []
      : (listing.accessRequests ?? []).filter((request) => request.botId === bot.id)
    // A down host's bot is its row alone, as on the desktop: no client keeps its chats.
    const listsUnder = botListsUnderRow({
      folded: inputs.collapsedGroups.has(groupKey),
      hostDown: Boolean(offline)
    })
    // The row's own dot and words are its own turn; its workspaces' work shows on the fold, as on the desktop.
    // A down host's last read is not live: no dot, no fold status.
    const dot: BotRowStatus = offline ? 'inactive' : foldBotStatus(own, bot.paused)
    const drawnHome = shown(home.row)
    const place = (line: WorkspaceListItem) =>
      placeWorkerLine(line, hostOf(line.row), hostId, hosts)
    // Searching lists the matching workspaces flat, as before chats; otherwise its chats, once read. A
    // down host's last tree is not live, and its bot lists nothing.
    const tree = query || offline ? undefined : inputs.chatTrees.get(hostBotTreeKey(hostId, bot.id))
    const chatItems =
      tree === 'loading'
        ? [
            {
              row: drawnHome.row,
              view: {
                sectionListKey: `bot-chat-loading:${identity(home.row)}`,
                botChatLoading: true as const,
                ...(bot.paused ? { dimmed: true as const } : {})
              }
            }
          ]
        : hostBotChatItems({
            tree,
            branches: branches.map((branch) => ({ id: branch.id, lines: branch.lines.map(place) })),
            home: drawnHome,
            homeIdentity: identity(home.row),
            hostKey: hostBotsKey(inputs.pairedHostId, hostId),
            botId: bot.id,
            folds: inputs.chatFolds,
            steps: inputs.chatSteps,
            dimmed: bot.paused
          })
    // A down host shows no live work.
    const workerCounts = countLiveBotWorkspaces(offline ? [] : workspaceStatuses)
    const botFacts = {
      botId: bot.id,
      // Its chats fold with it, even with no workspace under them.
      ...(chatItems && chatItems.length > 0 ? { foldsChats: true as const } : {}),
      avatar: mobileBotAvatarSource(bot),
      status,
      dot,
      foldLive: offline ? null : botFoldLiveStatus(workerCounts),
      ...(upNext > 0 ? { upNext } : {}),
      line: {
        chatSessionId: bot.chatSessionId ?? null,
        links: listing.links?.[home.id] ?? [],
        ...(listing.ownChats?.[bot.id] ? { chats: listing.ownChats[bot.id] } : {}),
        waits: listing.waits?.[bot.id] ?? [],
        workers: workerCounts,
        // As the desktop's line counts them: its items and the people asking, beside its rows' asks.
        itemsNeedingYou: needsYou + access.length
      },
      ...(access[0] ? { askedForAccess: accessRequestPerson(access[0]) } : {}),
      statusLine: botStatusLine(dot, bot.paused, translate),
      paused: bot.paused,
      ...(host ? { host } : {})
    }
    const botRow: WorkspaceListItem = {
      row: { ...drawnHome.row, displayName: bot.name },
      view: {
        ...drawnHome.view,
        sectionListKey: `bot:${identity(home.row)}`,
        lineageDepth: 0,
        projectGroupDepth: 0,
        inFolderScanGroup: false,
        lineageGroupKey: groupKey,
        lineageChildCount: offline
          ? 0
          : lines.filter((line) => line.view.projectGroupDepth === 1).length,
        lineageCollapsed: inputs.collapsedGroups.has(groupKey),
        ...(bot.paused || offline ? { dimmed: true } : {}),
        botFacts
      }
    }
    const placed = chatItems ?? lines.map(place)
    const shownLines = query ? placed.filter((line) => matches(line.row, query)) : placed
    if (query && !matches(botRow.row, query) && shownLines.length === 0) {
      continue
    }
    drawn.push({
      entry,
      items: [botRow, ...(listsUnder ? shownLines : [])],
      preview: {
        id: composeWorktreeHostIdentity(hostId, bot.id),
        name: bot.name,
        avatar: botFacts.avatar,
        ...preview,
        // A down host's faces carry no live pip.
        ...(offline ? { status: 'inactive' as const, attention: false, unread: false } : {})
      },
      activity: {
        needsYou: preview.attention === true,
        activityAt: activityAt([home.row, ...workers])
      }
    })
  }
  const shownTotal = entries.filter((entry) => entry.kind !== 'bot' || !entry.bot.paused).length
  return { drawn, listed, total: entries.length, shownTotal }
}
