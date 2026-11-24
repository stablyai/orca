import type { BotGroup } from '../../../src/shared/bots/bot-group'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import type { BotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import type { BotListWaits } from '../../../src/shared/bots/bot-list-waits'
import type { BotRowLineChat, BotRowLineLink } from '../../../src/shared/bots/bot-row-line'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { WorkspaceLineage, WorktreeLineage } from '../../../src/shared/worktree/lineage-types'
import {
  serverHostHealth,
  serverHostHealthLabel
} from '../worktree/execution-hosts/server-host-health'
import { getHostHealthBadgeLabel } from '../worktree/execution-hosts/worktree-host-health'
import type { ListedBot } from './host-bots-operations'
import { translate } from '../i18n/mobile-i18n'

/** Why a host takes no new bot from this phone: its Bots switch, its build, or the paired desktop's. */
export type NewBotRefusal = 'bots-off' | 'update' | 'update-desktop'

/** Why this host takes no new bot from the phone; undefined when it takes one. `relaysCreate`: the
 *  route reaches its bots.create. */
export function newBotRefusal(
  bots: { enabled: boolean; takesCreate: boolean },
  relaysCreate: boolean
): NewBotRefusal | undefined {
  if (!bots.enabled) {
    return 'bots-off'
  }
  if (!bots.takesCreate) {
    return 'update'
  }
  return relaysCreate ? undefined : 'update-desktop'
}

export type ListedHostBots = {
  kind: 'listed'
  hostId: ExecutionHostId
  hostLabel: string
  /** The server's store identity when read: a different server under the same id drops these rows. */
  installationId?: string
  bots: readonly ListedBot[]
  /** The host's Hide bot workspaces: on, a bot's workspaces leave their projects. */
  hideBotCreated: boolean
  /** The host's Bot options, so the phone lists its bots as its sidebar does. */
  view: BotSidebarView
  workspaceLineage: Readonly<Record<string, WorkspaceLineage>>
  worktreeLineage: Readonly<Record<string, WorktreeLineage>>
  /** The separate lineage read failed, so bot workers cannot be shown until the host answers it. */
  workerStatus: 'available' | 'unavailable'
  unseen?: Readonly<Record<string, number>>
  /** Each bot's waits still waiting, by bot id, for its row's line. */
  waits?: BotListWaits
  /** Each bot's Needs you items that aren't stale, by bot id; empty from an older host. */
  needsYou?: Readonly<Record<string, number>>
  /** When those counts next change: the list reads the host again then. */
  needsYouChangeInMs?: number
  /** Each bot home's thread links, by folder workspace id, for its row's line. */
  links?: Readonly<Record<string, readonly BotRowLineLink[]>>
  /** The host's waiting access requests, every bot's, for each row's Needs you line; absent while
   *  their read fails or the host is signed out of Orca. */
  accessRequests?: readonly ConnectorAccessRequest[]
  /** Each bot's own side chats, by bot id, for its row's line; absent from an older host. */
  ownChats?: Readonly<Record<string, readonly BotRowLineChat[]>>
  /** Absent when the host takes a new bot from this phone. */
  createRefusal?: NewBotRefusal
  /** The host makes bots from template packages (`bots.templates.v2`). */
  takesTemplates?: boolean
  /** Its groups, which list as their rooms among its bots, never as folders; absent while their read fails. */
  groups?: readonly BotGroup[]
  /** The host's word while it is down (e.g. "Disconnected"): its last-read bots stay, dimmed. */
  offline?: string
}

/** One host's bots as the phone read them; `update-needed` is a host too old to serve them, and
 *  `unreachable` a server down since before this screen read it. */
export type HostBotListing =
  | ListedHostBots
  | { kind: 'update-needed'; hostId: ExecutionHostId; hostLabel: string }
  | { kind: 'unreachable'; hostId: ExecutionHostId; hostLabel: string }

/** A down server's word, as its workspace pill says it; a computer that's simply away is "Offline",
 *  the one word bots use for it everywhere. */
export function serverHostDownWord(host: MobileRelayHost): string | undefined {
  const health = serverHostHealth(host)
  const word =
    serverHostHealthLabel(host) ??
    (health === 'disconnected' ? undefined : getHostHealthBadgeLabel(health))
  return (
    word ?? (host.relay === 'ready' && health !== 'disconnected' ? undefined : botsOfflineWord())
  )
}

export function botsOfflineWord(): string {
  return translate('bots.list.offline', 'Offline')
}

/** What the list shows of each host's last read: this computer first, then each server in the
 *  desktop's order. A down server keeps its last read, dimmed, while the desktop still lists the
 *  same install; one never read says it can't be reached; one too old says so. */
export function shownHostBotListings(
  stored: readonly HostBotListing[],
  serverHosts: readonly MobileRelayHost[]
): HostBotListing[] {
  const local = stored.find((listing) => listing.hostId === LOCAL_EXECUTION_HOST_ID)
  const servers = serverHosts.flatMap((host): HostBotListing[] => {
    const named = { hostId: host.hostId, hostLabel: host.label }
    if (host.relay === 'update-needed') {
      return [{ kind: 'update-needed', ...named }]
    }
    const last = stored.find((listing) => listing.hostId === host.hostId)
    const kept =
      last?.kind === 'listed' && last.installationId !== host.installationId ? undefined : last
    const down = serverHostDownWord(host)
    if (!down) {
      return kept ? [kept.kind === 'listed' ? { ...kept, hostLabel: host.label } : kept] : []
    }
    if (kept?.kind === 'listed') {
      return [{ ...kept, hostLabel: host.label, offline: down }]
    }
    if (kept) {
      return [kept]
    }
    // A server that is up but whose read failed keeps its folders in Projects and reads again.
    return host.health === 'available' ? [] : [{ kind: 'unreachable', ...named }]
  })
  return [...(local ? [local] : []), ...servers]
}
