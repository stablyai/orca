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
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  homeAgentEntries,
  type HomeAgentBot,
  type HomeAgentEntry,
  type HomeWorktreeSummary
} from './home-worktree-info'
import { isWorktreeActive } from '../workspace-list/workspace-row-filtering'
import type { WorkspaceLineage } from '../../../../src/shared/worktree/lineage-types'
import { workspaceLineageRead } from '../../bots/host-bots-operations'
import { readHostMethodReply } from '../../host-screen/sidebar-feed/host-sidebar-feed-operations'
import {
  readWorktreeCatalogSnapshot,
  type WorktreeCatalogSnapshot
} from './worktree-catalog-snapshot-client'

// Same pace as the workspace list's poll; agent status notices can arrive many times a second.
const HOME_WORKTREE_REFRESH_FLOOR_MS = 3000

/** What a desktop card and the Agents list draw from one worktree.ps read. */
export type HomeWorktreeCounts = {
  projects?: readonly Pick<HomeWorktreeSummary, 'worktreeId' | 'repo' | 'hostId'>[]
  totalWorktrees: number
  activeCount: number
  agents: readonly HomeAgentEntry[]
  /** Unread rows' ids, for the rows Home draws over a hidden home (a group room). */
  unreadWorktreeIds?: readonly string[]
  // The rows this launch read: the next read's delta base, the wide layout's host list seed, and its
  // bots' workers. Never stored.
  catalog?: WorktreeCatalogSnapshot
  /** The host's folder records, for a bot's worker that doesn't report its folder parent, and the
   *  workspaces they were read for (null: read again); read only while it has bots. Never stored. */
  folderRecords?: {
    ids: string | null
    records: Readonly<Record<string, WorkspaceLineage>> | undefined
  }
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
    const folderRecords =
      botByHomeId.size > 0 ? await readFolderRecords(client, catalog, previous) : undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque because three screens project a row differently. Home reads `status`, `sidebarStatus` and its counts through their own guards, plus the host-typed `agents` the Agents list shows, and the `worktree-home-catalog` golden records the row it is given as `{worktreeId, displayName, repo, status}`.
    const worktrees = catalog.worktrees as HomeWorktreeSummary[]
    // Count what the list shows: archived rows are hidden, and active is the sleeping filter's rule.
    const unarchived = worktrees.filter((w) => w.isArchived !== true)
    const listed = unarchived.filter((w) => !botByHomeId.has(w.worktreeId))
    return {
      projects: listed.map(({ worktreeId, repo, hostId }) => ({ worktreeId, repo, hostId })),
      totalWorktrees: listed.length,
      activeCount: listed.filter(isWorktreeActive).length,
      // A bot's chats stay agents: one waiting on the user reaches Active and the badge.
      agents: homeAgentEntries(unarchived, botByHomeId),
      unreadWorktreeIds: unarchived.flatMap((w) => (w.unread === true ? [w.worktreeId] : [])),
      catalog,
      ...(folderRecords ? { folderRecords } : {})
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

/** The host's workspaces as a set, whatever order its activity lists them in. */
const worktreeIdsOf = (catalog: WorktreeCatalogSnapshot): string =>
  catalog.worktrees
    .map((row) => row.worktreeId)
    .sort()
    .join('\n')

/** The host's folder records, read again only when its workspaces change: agent turns refresh Home
 *  every few seconds, and the records only place a new workspace. A failed read keeps the last and
 *  asks again next time; a host without the method isn't asked again for the same workspaces. */
async function readFolderRecords(
  client: RpcClient,
  catalog: WorktreeCatalogSnapshot,
  previous: HomeWorktreeCounts | undefined
): Promise<HomeWorktreeCounts['folderRecords']> {
  const ids = worktreeIdsOf(catalog)
  const kept = previous?.folderRecords
  if (kept?.ids === ids) {
    return kept
  }
  const reply = await workspaceLineageRead.request(client).catch(() => null)
  const read = reply && readHostMethodReply(reply, workspaceLineageRead.interpret)
  return read?.kind === 'answered'
    ? { ids, records: read.value.workspaceLineage }
    : read?.kind === 'unavailable'
      ? { ids, records: kept?.records }
      : kept && { ids: null, records: kept.records }
}

function botsByHomeWorktreeId(answer: HostBotsRead): ReadonlyMap<string, HomeAgentBot> {
  return new Map(
    answer.kind === 'bots'
      ? answer.bots.map((bot) => [
          botHomeWorktreeId(bot),
          { id: bot.id, name: bot.name, avatar: bot.avatar }
        ])
      : []
  )
}
