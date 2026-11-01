/**
 * Once the WSL host owns a moved project, its existing native chats stay on this computer and keep
 * working (owner decision, option C), so their tabs take the renderer's writes again. Every other
 * row of the workspace stays exactly as the quiesce left it: that slept state is what a downgrade
 * restores, and its terminals and editors now live on the host.
 */
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

function isChatTab(tab: Pick<Tab, 'contentType'>): boolean {
  return tab.contentType === 'agent-session'
}

type HostOwnedChatTabRows = Pick<
  WorkspaceSessionState,
  'unifiedTabs' | 'tabGroups' | 'tabGroupLayouts'
>

/**
 * `workspaceId`'s rows with `next`'s chat tabs in place of the frozen ones `frozen` holds, or null
 * when neither side has a chat. Only the freeze splice merges them; this never writes a session.
 */
export function hostOwnedChatTabRows(
  frozen: WorkspaceSessionState,
  next: WorkspaceSessionState,
  workspaceId: string
): HostOwnedChatTabRows | null {
  const priorTabs = frozen.unifiedTabs?.[workspaceId] ?? []
  const nextChats = (next.unifiedTabs?.[workspaceId] ?? []).filter(isChatTab)
  const priorChatIds = new Set(priorTabs.filter(isChatTab).map((tab) => tab.id))
  const nextChatIds = new Set(nextChats.map((tab) => tab.id))
  if (priorChatIds.size === 0 && nextChatIds.size === 0) {
    return null
  }
  const priorGroups = frozen.tabGroups?.[workspaceId] ?? []
  // Why reuse prior groups: the frozen layout names them, so a new group would never render.
  const groups =
    priorGroups.length > 0
      ? placeChatsInPriorGroups(priorGroups, next.tabGroups?.[workspaceId] ?? [], {
          priorChatIds,
          nextChatIds,
          nextChats
        })
      : (next.tabGroups?.[workspaceId] ?? []).map((group) => ({
          ...group,
          tabOrder: group.tabOrder.filter((id) => nextChatIds.has(id))
        }))
  const groupIdByTab = new Map(
    groups.flatMap((group) => group.tabOrder.map((id) => [id, group.id]))
  )
  const tabs = [
    ...priorTabs.filter((tab) => !isChatTab(tab)),
    ...nextChats.map((tab) => {
      const groupId = groupIdByTab.get(tab.id) ?? tab.groupId
      return groupId === tab.groupId ? tab : { ...tab, groupId }
    })
  ]
  const nextLayout = priorGroups.length === 0 ? next.tabGroupLayouts?.[workspaceId] : undefined
  return {
    unifiedTabs: { [workspaceId]: tabs },
    tabGroups: { [workspaceId]: groups },
    ...(nextLayout ? { tabGroupLayouts: { [workspaceId]: nextLayout } } : {})
  }
}

type ChatPlacement = {
  priorChatIds: ReadonlySet<string>
  nextChatIds: ReadonlySet<string>
  nextChats: readonly Tab[]
}

function placeChatsInPriorGroups(
  priorGroups: readonly TabGroup[],
  nextGroups: readonly TabGroup[],
  { priorChatIds, nextChatIds, nextChats }: ChatPlacement
): TabGroup[] {
  const groups = priorGroups.map((group) => ({
    ...group,
    tabOrder: group.tabOrder.filter((id) => !priorChatIds.has(id) || nextChatIds.has(id))
  }))
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  const nextGroupByTab = new Map(
    nextGroups.flatMap((group) => group.tabOrder.map((id) => [id, group.id]))
  )
  for (const chat of nextChats) {
    if (placed.has(chat.id)) {
      continue
    }
    const wanted = nextGroupByTab.get(chat.id) ?? chat.groupId
    const group = groups.find((candidate) => candidate.id === wanted) ?? groups[0]
    group.tabOrder = [...group.tabOrder, chat.id]
    placed.add(chat.id)
  }
  const nextActiveByGroup = new Map(nextGroups.map((group) => [group.id, group.activeTabId]))
  return groups.map((group) => {
    const nextActive = nextActiveByGroup.get(group.id)
    const activeTabId =
      nextActive && nextChatIds.has(nextActive) && group.tabOrder.includes(nextActive)
        ? nextActive
        : group.activeTabId && group.tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (group.tabOrder.at(-1) ?? null)
    const recentTabIds = group.recentTabIds?.filter((id) => group.tabOrder.includes(id))
    return { ...group, activeTabId, ...(recentTabIds ? { recentTabIds } : {}) }
  })
}
