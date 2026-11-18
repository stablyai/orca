import * as z from 'zod'
import {
  botHomeWorktreeId,
  hostBotsKey,
  readHostBots,
  type HostBotsRead
} from '../../bots/host-bots-read'
import {
  HOME_WORKTREE_COUNTS_FAMILY,
  type NO_HOST_LIST_INPUT
} from '../../host-screen/catalog/host-list-queries'
import { defineHostQuery } from '../../query/host-query'
import {
  homeAgentEntries,
  homeWorkspaceEntries,
  type HomeAgentBot,
  type HomeAgentEntry,
  type HomeWorkspaceEntry,
  type HomeWorktreeSummary
} from './home-worktree-info'
import { isWorktreeActive } from '../workspace-list/workspace-row-filtering'
import {
  readWorktreeCatalogSnapshot,
  type WorktreeCatalogSnapshot
} from './worktree-catalog-snapshot-client'

// Same pace as the workspace list's poll; agent status notices can arrive many times a second.
const HOME_WORKTREE_REFRESH_FLOOR_MS = 3000

/** What a desktop card and the Agents list draw from one worktree.ps read. */
export type HomeWorktreeCounts = {
  totalWorktrees: number
  activeCount: number
  agents: readonly HomeAgentEntry[]
  // Unarchived workspaces for the Agents search; never stored, like agents.
  workspaces?: readonly HomeWorkspaceEntry[]
  /** Unread rows' ids, for the rows Home draws over a hidden home (a group room). */
  unreadWorktreeIds?: readonly string[]
  // The rows this launch read: the next read's delta base, and the wide layout's host list seed. Never stored.
  catalog?: WorktreeCatalogSnapshot
}

export const homeWorktreeCountsQuery = defineHostQuery<
  typeof NO_HOST_LIST_INPUT,
  HomeWorktreeCounts
>({
  family: HOME_WORKTREE_COUNTS_FAMILY,
  fetch: async (client, _target, _input, previous, { hostId }) => {
    // Bot homes are listed as bots, not worktrees; a host too old to name them keeps today's count.
    const bots = readHostBots(client, hostBotsKey(hostId))
    const catalog = await readWorktreeCatalogSnapshot(client, previous?.catalog)
    const botByHomeId = botsByHomeWorktreeId(await bots)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque because three screens project a row differently. Home reads `status`, `sidebarStatus` and its counts through their own guards, plus the host-typed `agents` the Agents list shows, and the `worktree-home-catalog` golden records the row it is given as `{worktreeId, displayName, repo, status}`.
    const worktrees = catalog.worktrees as HomeWorktreeSummary[]
    // Count what the list shows: archived rows are hidden, and active is the sleeping filter's rule.
    const unarchived = worktrees.filter((w) => w.isArchived !== true)
    const listed = unarchived.filter((w) => !botByHomeId.has(w.worktreeId))
    return {
      totalWorktrees: listed.length,
      activeCount: listed.filter(isWorktreeActive).length,
      // A bot's chats stay agents: one waiting on the user reaches Active and the badge.
      agents: homeAgentEntries(unarchived, botByHomeId),
      workspaces: homeWorkspaceEntries(listed),
      unreadWorktreeIds: unarchived.flatMap((w) => (w.unread === true ? [w.worktreeId] : [])),
      catalog
    }
  },
  staleTime: HOME_WORKTREE_REFRESH_FLOOR_MS,
  // Home stays mounted for the whole launch; its cards must not empty while it sits under a screen.
  gcTime: Infinity,
  // Change notices that arrive in the background only mark it stale.
  refetchOnWindowFocus: true,
  signal: {
    events: [
      'sidebarInputsChanged',
      'worktreesChanged',
      'reposChanged',
      // The desktop Agents list changed; worktree.ps carries its verdicts.
      'agentListChanged',
      // Agent status changes on hosts without the sidebar feed (worktree.rows-changed-event.v1).
      'worktreeRowsChanged'
    ],
    floorMs: HOME_WORKTREE_REFRESH_FLOOR_MS
  },
  persist: {
    version: 1,
    // Agent attention is only ever shown from a live read (K1), so the stored copy keeps none.
    dataSchema: z.object({
      totalWorktrees: z.number().int().nonnegative(),
      activeCount: z.number().int().nonnegative(),
      agents: z.tuple([])
    }),
    strip: ({ totalWorktrees, activeCount }) => ({ totalWorktrees, activeCount, agents: [] })
  }
})

function botsByHomeWorktreeId(answer: HostBotsRead): ReadonlyMap<string, HomeAgentBot> {
  return new Map(
    answer.kind === 'bots'
      ? answer.bots.map((bot) => [botHomeWorktreeId(bot), { name: bot.name, avatar: bot.avatar }])
      : []
  )
}
