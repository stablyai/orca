import { useMemo, useSyncExternalStore } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import type { MobileLineageStores } from '../worktree/agent-lineage/mobile-workspace-lineage'
import type { LastVisitedWorktreeOnHost } from '../worktree/row-presentation/host-list-highlight'
import { getMobileUiRevision, subscribeMobileUiLanguage } from '../i18n/mobile-i18n'
import {
  buildHostBotSections,
  type HostBotListing,
  type HostBotSections
} from './host-bot-sections'
import { drawBotRow } from './host-bot-row-draw'
import { useBotPurposes } from './use-bot-purposes'
import { useHostBotChatListInputs } from './use-host-bot-chat-trees'
import { usePublishedBotStatuses } from './use-published-bot-statuses'

/** The host list's Bots section, drawn from every host's bots, their chats and the list's search. */
export function useHostBotSections(args: {
  client: RpcClient | null
  /** The paired host answers; a search's purpose read waits for it, and reads again after a reconnect. */
  connected: boolean
  hostId: string | undefined
  hostCapabilities: readonly string[]
  listings: readonly HostBotListing[]
  rows: readonly Worktree[]
  collapsedGroups: ReadonlySet<string>
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  search: string
  lastVisited: LastVisitedWorktreeOnHost | null
  lineageStores: MobileLineageStores
}): HostBotSections {
  const { listings, rows, collapsedGroups, repoHostIdByRepoId, search, lastVisited } = args
  const chatInputs = useHostBotChatListInputs({
    client: args.client,
    pairedHostId: args.hostId,
    hostCapabilities: args.hostCapabilities,
    listings,
    collapsedGroups
  })
  const uiRevision = useSyncExternalStore(subscribeMobileUiLanguage, getMobileUiRevision)
  // Read again each time a search over this computer's bots starts, as the desktop's does, so an edited purpose matches.
  const searchesOwnBots =
    search.trim() !== '' &&
    listings.some(
      (listing) =>
        listing.kind === 'listed' &&
        listing.hostId === LOCAL_EXECUTION_HOST_ID &&
        listing.bots.length > 0
    )
  const purposes = useBotPurposes(searchesOwnBots && args.connected ? args.client : null)
  const sections = useMemo(
    () =>
      buildHostBotSections({
        rows,
        listings,
        collapsedGroups,
        repoHostIdByRepoId,
        search,
        purposes,
        drawRow: drawBotRow(lastVisited),
        lineageStores: args.lineageStores,
        ...chatInputs
      }),
    [
      rows,
      listings,
      collapsedGroups,
      repoHostIdByRepoId,
      search,
      purposes,
      lastVisited,
      args.lineageStores,
      chatInputs,
      // Status lines are translated while drawn, so a language switch draws them again.
      uiRevision
    ]
  )
  usePublishedBotStatuses(args.hostId, listings, sections.sections)
  return sections
}
