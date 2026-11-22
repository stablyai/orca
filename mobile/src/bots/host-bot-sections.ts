import { isHome } from '../../../src/shared/bots/bot-homes'
import {
  arrangeBotSidebarEntries,
  DEFAULT_BOT_SIDEBAR_VIEW
} from '../../../src/shared/bots/bot-sidebar-view'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { BOTS_GROUP_KEY } from '../../../src/shared/sidebar-list/sections/group-keys'
import { parseWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import type {
  BotsListEndLine,
  Section,
  Worktree
} from '../worktree/workspace-list/workspace-list-types'
import { resolveWorktreeHostId } from '../worktree/row-presentation/worktree-host-context-labels'
import type { HostBotListing, ListedHostBots } from './host-bot-listing'
import {
  drawHostBotEntries,
  type BotHostNames,
  type DrawnBotEntry,
  type HostBotSectionInputs
} from './host-bot-entries'
import { lazyHostBotLineage } from './host-bot-worker-lines'
import { translate } from '../i18n/mobile-i18n'

export type { HostBotListing } from './host-bot-listing'
export type { HostBotSectionInputs } from './host-bot-entries'

export type HostBotSections = {
  sections: Section[]
  /** Host identities the Bots section lists, which the project list leaves out before it plans. */
  listedIdentities: ReadonlySet<string>
}

const NO_BOTS: HostBotSections = { sections: [], listedIdentities: new Set() }

/** The computer "+" makes a bot on first: this one, else the first that takes one. */
export function defaultNewBotHostId(listings: readonly HostBotListing[]): ExecutionHostId | null {
  const takers = listings.filter(
    (listing): listing is ListedHostBots =>
      listing.kind === 'listed' && !listing.createRefusal && !listing.offline
  )
  return (
    takers.find((listing) => listing.hostId === LOCAL_EXECUTION_HOST_ID)?.hostId ??
    takers[0]?.hostId ??
    null
  )
}

/** The one Bots section over this computer and every server it relays, and the rows it lists,
 *  which the project list leaves out as the desktop's does. */
export function buildHostBotSections(inputs: HostBotSectionInputs): HostBotSections {
  const { listings } = inputs
  const local = listings.find((listing) => listing.hostId === LOCAL_EXECUTION_HOST_ID)
  // The paired computer's Bots switch, off, hides every bot, as its sidebar does; a failed read never does.
  if (listings.length === 0 || (local?.kind === 'listed' && local.createRefusal === 'bots-off')) {
    return NO_BOTS
  }
  const hostOf = (row: Worktree) => resolveWorktreeHostId(row, inputs.repoHostIdByRepoId)
  const listedIdentities = new Set<string>()
  const lineageOf = lazyHostBotLineage(
    inputs.rows,
    inputs.lineageStores,
    hostOf,
    new Map(
      listings.flatMap((listing) =>
        listing.kind === 'listed' ? [[listing.hostId, listing.workspaceLineage] as const] : []
      )
    )
  )
  const hosts: BotHostNames = new Map(
    listings.map((listing) => [
      listing.hostId,
      {
        label: listing.hostLabel,
        ...(listing.kind === 'listed' && listing.offline ? { offline: listing.offline } : {})
      }
    ])
  )
  const drawn: DrawnBotEntry[] = []
  const endLines: BotsListEndLine[] = []
  let total = 0
  let shownTotal = 0
  for (const listing of listings) {
    const hostRows = inputs.rows.filter((row) => hostOf(row) === listing.hostId)
    // New bot's computer list says this host needs an update; the list itself stays quiet.
    if (listing.kind === 'update-needed') {
      continue
    }
    if (listing.kind === 'unreachable') {
      endLines.push({
        key: `unreachable:${listing.hostId}`,
        text: translate(
          'bots.list.cantReach',
          'Can’t reach {{host}}. Its bots show when it’s back.',
          { host: listing.hostLabel }
        )
      })
      // Its bots aren't listed until it connects, and their homes don't show as folders meanwhile.
      for (const row of hostRows) {
        // The host marks its own bot homes, wherever its profile keeps them.
        if (row.botHome === true) {
          listedIdentities.add(composeWorktreeHostIdentity(listing.hostId, row.worktreeId))
        }
      }
      continue
    }
    const host = drawHostBotEntries(listing, hostRows, inputs, lineageOf, hosts)
    drawn.push(...host.drawn)
    host.listed.forEach((identity) => listedIdentities.add(identity))
    total += host.total
    shownTotal += host.shownTotal
    for (const row of hostRows) {
      const scope = parseWorkspaceKey(row.worktreeId)
      const home = scope?.type === 'folder' && {
        id: scope.folderWorkspaceId,
        executionHostId: listing.hostId
      }
      if (
        home &&
        isHome(
          home,
          (listing.groups ?? []).map((group) => ({
            folderWorkspaceId: group.folderWorkspaceId,
            hostId: listing.hostId
          }))
        )
      ) {
        listedIdentities.add(composeWorktreeHostIdentity(listing.hostId, row.worktreeId))
      }
    }
  }
  const newBotHostId = defaultNewBotHostId(listings)
  if (total === 0 && !newBotHostId && endLines.length === 0) {
    return { sections: [], listedIdentities }
  }
  // The paired computer's Bot options order and filter every computer's bots: Manual keeps this
  // computer's, then each server's, in their saved orders.
  const view = local?.kind === 'listed' ? local.view : DEFAULT_BOT_SIDEBAR_VIEW
  const arranged = arrangeBotSidebarEntries(
    drawn.map((entry) => ({ ...entry.entry, drawn: entry })),
    view,
    ({ drawn: entry }) => entry.activity
  ).map(({ drawn: entry }) => entry)
  const searching = inputs.search.trim().length > 0
  // With no bots the header's + says enough; only a computer it can't reach gets a line.
  const lines = searching ? [] : endLines
  return {
    sections: [
      {
        key: BOTS_GROUP_KEY,
        title: translate('bots.section.title', 'Bots'),
        // Paused bots the options hide leave the count too, as on the desktop.
        count: view.hidePausedBots ? shownTotal : total,
        ...(newBotHostId ? { newBotHostId } : {}),
        // Groups are this computer's: New group counts its bots alone, whatever the search hides.
        botCount: local?.kind === 'listed' ? local.bots.length : 0,
        ...(lines.length > 0 ? { endLines: lines } : {}),
        botPreview: arranged.flatMap(({ preview }) => preview ?? []),
        data: inputs.collapsedGroups.has(BOTS_GROUP_KEY)
          ? []
          : arranged.flatMap(({ items }, index) =>
              // Each bot or group after the first draws the divider above it.
              items.map((item, at) =>
                index > 0 && at === 0
                  ? { row: item.row, view: { ...item.view, botDivider: true as const } }
                  : item
              )
            )
      }
    ],
    listedIdentities
  }
}

/** Whether a row stays in the project list: not one the Bots section lists. */
export function isProjectListRow(
  row: Worktree,
  listedIdentities: ReadonlySet<string>,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): boolean {
  return !listedIdentities.has(
    composeWorktreeHostIdentity(resolveWorktreeHostId(row, repoHostIdByRepoId), row.worktreeId)
  )
}
