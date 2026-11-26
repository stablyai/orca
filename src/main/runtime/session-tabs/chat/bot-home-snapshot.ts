// A bot's Home holds the left of its page on every client this host serves; its side chats never pin.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  collectTabGroupLayoutGroupIds,
  removeTabGroupLayoutLeaf
} from '../../../../shared/workspace-layout/tab-groups/tab-group-moves'
import type { Bot } from '../../../../shared/bot-types'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { areHostBotsEnabled } from '../../../bots/bot-team-policy'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

type BotHomeStore = {
  getSettings?: () => Partial<Pick<GlobalSettings, 'botsEnabled'>>
  getBots?: () => readonly Pick<Bot, 'folderWorkspaceId' | 'chatSessionId'>[]
}

/** The session the bot whose home `workspaceId` is names Home now; null off a bot's page or with bots off. */
export function botHomeSessionId(
  store: BotHomeStore | null | undefined,
  workspaceId: string
): string | null {
  return areHostBotsEnabled(store?.getSettings?.())
    ? (botOfHomeWorkspace(store?.getBots?.() ?? [], workspaceId)?.chatSessionId ?? null)
    : null
}

/** Why a pin edit on a bot's page is refused; null when allowed. Home stays pinned, side chats never pin. */
export function botHomePinRefusal(
  snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'tabs'> | undefined,
  homeSessionId: string | null,
  tabId: string,
  isPinned: boolean | undefined
): string | null {
  const row = snapshot?.tabs.find((tab) => tab.id === tabId)
  if (isPinned === undefined || !homeSessionId || row?.type !== 'agent-session') {
    return null
  }
  const home = row.sessionId === homeSessionId
  if (home === isPinned) {
    return null
  }
  return home ? "A bot's Home chat stays pinned" : "A bot's side chats can't be pinned"
}

type PinnableRow = { type: string; id: string; isPinned?: boolean; sessionId?: string }

/** Every agent row says whether it is pinned, false too: a client keeps its own pin when the field is absent. */
export function withBotHomePins<T extends { tabs: readonly PinnableRow[] }>(
  result: T,
  homeSessionId: string
): T {
  if (
    result.tabs.every(
      (tab) => tab.type !== 'agent-session' || tab.isPinned === (tab.sessionId === homeSessionId)
    )
  ) {
    return result
  }
  return {
    ...result,
    tabs: result.tabs.map((tab) =>
      tab.type === 'agent-session' ? { ...tab, isPinned: tab.sessionId === homeSessionId } : tab
    )
  }
}

/**
 * The windowless host's own placement: one Home row, first in the first group in layout order that
 * holds tabs. Extra Home rows are views of the same conversation, so dropping them never retires it.
 * `currentHomeTabId` is the host's own tab for the Home session and survives when listed.
 */
export function placeBotHomeInSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  homeSessionId: string,
  currentHomeTabId: string | null
): RuntimeMobileSessionTabsSnapshot {
  const homes = snapshot.tabs.filter(
    (tab) => tab.type === 'agent-session' && tab.sessionId === homeSessionId
  )
  const home = homes.find((tab) => tab.id === currentHomeTabId) ?? homes[0]
  if (!home) {
    return snapshot
  }
  const dropped = new Set(homes.filter((tab) => tab !== home).map((tab) => tab.id))
  // A group's selection stays inside it: a dropped duplicate hands over to Home there, else to its first tab.
  const reselect = (selected: string | null, tabOrder: string[], gone: (id: string) => boolean) =>
    selected !== null && gone(selected)
      ? tabOrder.includes(home.id)
        ? home.id
        : (tabOrder[0] ?? null)
      : selected
  let groups = (snapshot.tabGroups ?? []).map((group) => {
    const tabOrder = group.tabOrder.filter((id) => !dropped.has(id))
    return {
      ...group,
      tabOrder,
      activeTabId: reselect(group.activeTabId, tabOrder, (id) => dropped.has(id)),
      ...(group.recentTabIds
        ? { recentTabIds: group.recentTabIds.filter((id) => !dropped.has(id)) }
        : {})
    }
  })
  const activeTabId =
    snapshot.activeTabId !== null && dropped.has(snapshot.activeTabId)
      ? home.id
      : snapshot.activeTabId
  const byId = new Map(groups.map((group) => [group.id, group]))
  const target = [...collectTabGroupLayoutGroupIds(snapshot.tabGroupLayout)]
    .flatMap((id) => byId.get(id) ?? [])
    .concat(groups)
    .find((group) => group.tabOrder.length > 0)
  const moved = target !== undefined && target.tabOrder[0] !== home.id
  if (dropped.size === 0 && !moved) {
    return snapshot
  }
  if (target && moved) {
    groups = groups.map((group) => {
      if (group.id === target.id) {
        return { ...group, tabOrder: [home.id, ...group.tabOrder.filter((id) => id !== home.id)] }
      }
      const tabOrder = group.tabOrder.filter((id) => id !== home.id)
      return {
        ...group,
        tabOrder,
        activeTabId: reselect(group.activeTabId, tabOrder, (id) => id === home.id)
      }
    })
  }
  // A group placement emptied (Home moved out, or only a duplicate lived there) closes, as a renderer move collapses it.
  const emptied = new Set(
    (snapshot.tabGroups ?? [])
      .filter((group) => group.tabOrder.length > 0)
      .map((group) => group.id)
      .filter((id) => groups.find((group) => group.id === id)?.tabOrder.length === 0)
  )
  groups = groups.filter((group) => !emptied.has(group.id))
  let tabGroupLayout = snapshot.tabGroupLayout
  for (const id of emptied) {
    tabGroupLayout = removeTabGroupLayoutLeaf(tabGroupLayout, id)
  }
  // Focus on Home, its own or a dropped duplicate's, lands on the group that now holds it.
  const focusHome = activeTabId === home.id
  const homeGroupId = groups.find((group) => group.tabOrder.includes(home.id))?.id
  if (focusHome && homeGroupId) {
    groups = groups.map((group) =>
      group.id === homeGroupId ? { ...group, activeTabId: home.id } : group
    )
  }
  const activeGroupId =
    focusHome && homeGroupId
      ? homeGroupId
      : snapshot.activeGroupId !== null && emptied.has(snapshot.activeGroupId)
        ? (homeGroupId ?? groups[0]?.id ?? null)
        : snapshot.activeGroupId
  return {
    ...snapshot,
    activeTabId,
    activeGroupId,
    ...(snapshot.tabGroups ? { tabGroups: groups } : {}),
    ...(emptied.size > 0 && snapshot.tabGroupLayout !== undefined ? { tabGroupLayout } : {}),
    tabs: snapshot.tabs
      .filter((tab) => !dropped.has(tab.id))
      .map((tab) => (tab === home && focusHome && !tab.isActive ? { ...tab, isActive: true } : tab))
  }
}
