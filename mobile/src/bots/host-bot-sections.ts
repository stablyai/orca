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
  /** A search's paused bots the options hide, when they are its only bot matches. */
  pausedMatches?: number
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
  if (listings.length === 0) {
    return NO_BOTS
  }
  const local = listings.find((listing) => listing.hostId === LOCAL_EXECUTION_HOST_ID)
  // The paired computer's Bots switch, off, hides every bot, as its sidebar does; a failed read never does.
  const botsOff = local?.kind === 'listed' && local.createRefusal === 'bots-off'
  const hostOf = (row: Worktree) => resolveWorktreeHostId(row, inputs.repoHostIdByRepoId)
  const listedIdentities = new Set<string>()
  const endLines: BotsListEndLine[] = []
  /** A host whose bots don't list keeps the homes it marks out of its folders, and says why in one
   *  line. A host too old to mark them can't be told apart from real folders. */
  const unlisted = (hostId: ExecutionHostId, text: string, always: boolean): void => {
    let hid = false
    for (const row of inputs.rows) {
      if (row.botHome === true && hostOf(row) === hostId) {
        listedIdentities.add(composeWorktreeHostIdentity(hostId, row.worktreeId))
        hid = true
      }
    }
    if (hid || always) {
      endLines.push({ key: `unlisted:${hostId}`, text })
    }
  }
  const searching = inputs.search.trim().length > 0
  if (botsOff) {
    groupHomes(
      local,
      inputs.rows.filter((row) => hostOf(row) === LOCAL_EXECUTION_HOST_ID)
    ).forEach((identity) => listedIdentities.add(identity))
    unlisted(
      LOCAL_EXECUTION_HOST_ID,
      translate('bots.list.offEnd', 'Bots are off on {{host}}.', { host: local.hostLabel }),
      false
    )
    // A search shows only what matches, so its line waits.
    return endLines.length > 0 && !searching
      ? { sections: [botsSection({ count: 0, lines: endLines, data: [] })], listedIdentities }
      : { sections: [], listedIdentities }
  }
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
  let total = 0
  let shownTotal = 0
  for (const listing of listings) {
    const host = listing.hostLabel
    if (listing.kind === 'update-needed') {
      unlisted(
        listing.hostId,
        translate('bots.list.updateToSee', 'Update Orca on {{host}} to see its bots.', { host }),
        true
      )
      continue
    }
    if (listing.kind === 'read-failed') {
      unlisted(
        listing.hostId,
        translate('bots.list.readFailed', 'Couldn’t load the bots on {{host}}.', { host }),
        false
      )
      continue
    }
    if (listing.kind === 'unreachable') {
      // Its bots aren't listed until it connects, and their homes don't show as folders meanwhile.
      unlisted(
        listing.hostId,
        translate('bots.list.cantReach', 'Can’t reach {{host}}. Its bots show when it’s back.', {
          host
        }),
        true
      )
      continue
    }
    const hostRows = inputs.rows.filter((row) => hostOf(row) === listing.hostId)
    const drawnHost = drawHostBotEntries(listing, hostRows, inputs, lineageOf, hosts)
    drawn.push(...drawnHost.drawn)
    drawnHost.listed.forEach((identity) => listedIdentities.add(identity))
    total += drawnHost.total
    shownTotal += drawnHost.shownTotal
    groupHomes(listing, hostRows).forEach((identity) => listedIdentities.add(identity))
  }
  const newBotHostId = defaultNewBotHostId(listings)
  // With no bots the section goes; Home's Bots tab makes the first one.
  if (total === 0 && endLines.length === 0) {
    return { sections: [], listedIdentities }
  }
  // The paired computer's Bot options order and filter every computer's bots: Manual keeps this
  // computer's, then each server's, in their saved orders. Show paused lifts its filter for a search.
  const saved = local?.kind === 'listed' ? local.view : DEFAULT_BOT_SIDEBAR_VIEW
  const view = searching && inputs.showPaused ? { ...saved, hidePausedBots: false } : saved
  const arranged = arrangeBotSidebarEntries(
    drawn.map((entry) => ({ ...entry.entry, drawn: entry })),
    view,
    ({ drawn: entry }) => entry.activity
  ).map(({ drawn: entry }) => entry)
  // Matching paused bots the options hide are counted, as the desktop's search does.
  const pausedMatches =
    searching && view.hidePausedBots
      ? drawn.filter(({ entry }) => entry.kind === 'bot' && entry.bot.paused).length
      : 0
  // Nothing shown matches: the section goes, so the list's no-match view shows (with Show paused
  // when paused bots matched) unless a workspace matches.
  if (searching && arranged.length === 0) {
    return { sections: [], listedIdentities, pausedMatches }
  }
  const lines = searching
    ? pausedMatches > 0
      ? [{ key: 'paused-matches', text: pausedMatchesLine(pausedMatches) }]
      : []
    : endLines
  return {
    sections: [
      botsSection({
        // Paused bots the options hide leave the count too, as on the desktop; a search counts its matches.
        count: searching ? arranged.length : view.hidePausedBots ? shownTotal : total,
        lines,
        ...(newBotHostId ? { newBotHostId } : {}),
        // Groups are this computer's: New group counts its bots alone, whatever the search hides.
        botCount: local?.kind === 'listed' ? local.bots.length : 0,
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
      })
    ],
    listedIdentities
  }
}

function botsSection(parts: {
  count: number
  lines: BotsListEndLine[]
  newBotHostId?: ExecutionHostId
  botCount?: number
  botPreview?: NonNullable<Section['botPreview']>
  data: Section['data']
}): Section {
  const { lines, botPreview = [], ...rest } = parts
  return {
    key: BOTS_GROUP_KEY,
    title: translate('bots.section.title', 'Bots'),
    ...rest,
    ...(lines.length > 0 ? { endLines: lines } : {}),
    botPreview
  }
}

/** The host rows that are its groups' homes, which list as rooms, never as folders. */
function groupHomes(listing: ListedHostBots, hostRows: readonly Worktree[]): string[] {
  const homes = (listing.groups ?? []).map((group) => ({
    folderWorkspaceId: group.folderWorkspaceId,
    hostId: listing.hostId
  }))
  return hostRows.flatMap((row) => {
    const scope = parseWorkspaceKey(row.worktreeId)
    return scope?.type === 'folder' &&
      isHome({ id: scope.folderWorkspaceId, executionHostId: listing.hostId }, homes)
      ? [composeWorktreeHostIdentity(listing.hostId, row.worktreeId)]
      : []
  })
}

function pausedMatchesLine(count: number): string {
  return count === 1
    ? translate('bots.search.pausedMatches_one', '{{count}} paused match', { count })
    : translate('bots.search.pausedMatches_other', '{{count}} paused matches', { count })
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
