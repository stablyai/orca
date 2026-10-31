import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'
import {
  insertTabIdIntoOrder,
  partitionPinnedTabOrder
} from '../../../shared/workspace-layout/tab-order'
import { replaceSessionTabInSnapshot } from './session-tab-replace'

export type StructuredSessionTabProjection = {
  workspaceId: string
  sessionId: string
  agent: StructuredAgentId
  activate: boolean
  /** Where a new chat goes; absent means the end of the active group. */
  placement?: { groupId?: string; afterTabId?: string; index?: number }
  /** A same-slot switch: the chat takes this tab's slot and the tab's rows leave, in one write. */
  replaces?: string
  /** The layout owner's own write already decided `activate` from its source's selection. */
  selectionDecided?: boolean
}

/** Publish membership; a listed chat keeps its place, a new one goes last or into the replaced slot. */
export function projectStructuredSessionTab(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  input: StructuredSessionTabProjection
): RuntimeMobileSessionTabsSnapshot | null {
  const id = `agent-session:${input.sessionId}`
  const listed = existing?.tabs.some((tab) => tab.id === id)
  if (listed && !input.activate) {
    return null
  }
  const row = {
    type: 'agent-session' as const,
    id,
    title: defaultAgentChatLabel(input.agent),
    sessionId: input.sessionId,
    agent: input.agent,
    isActive: input.activate
  }
  if (input.replaces && !listed) {
    return replaceSessionTabInSnapshot(existing, {
      workspaceId: input.workspaceId,
      replacedTabId: input.replaces,
      row,
      activate: input.activate,
      selectionDecided: input.selectionDecided
    })
  }
  const tabs = [...(existing?.tabs ?? [])].map((tab) => ({
    ...tab,
    isActive: input.activate ? tab.id === id : tab.isActive
  }))
  if (!listed) {
    tabs.push(row)
  }
  const priorGroups = existing?.tabGroups ?? [
    {
      id: getHeadlessMobileSessionGroupId(input.workspaceId),
      activeTabId: existing?.activeTabId ?? null,
      tabOrder: []
    }
  ]
  const { placement } = input
  const listedGroup = priorGroups.find((group) => group.tabOrder.includes(id))
  const anchorGroup = priorGroups.find((group) =>
    group.tabOrder.includes(placement?.afterTabId ?? '')
  )
  const groupId =
    listedGroup?.id ??
    priorGroups.find((group) => group.id === placement?.groupId)?.id ??
    anchorGroup?.id ??
    priorGroups.find((group) => group.id === existing?.activeGroupId)?.id ??
    priorGroups[0]?.id
  const tabGroups = priorGroups.map((group) => {
    if (group.id !== groupId) {
      return group
    }
    let tabOrder = group.tabOrder
    if (!listedGroup) {
      const after = placement?.afterTabId
      if (after && tabOrder.includes(after)) {
        tabOrder = insertTabIdIntoOrder(tabOrder, tabs, id, false, after)
      } else if (placement?.index !== undefined) {
        const preceding = tabOrder[Math.max(0, Math.min(placement.index, tabOrder.length)) - 1]
        tabOrder = preceding
          ? insertTabIdIntoOrder(tabOrder, tabs, id, false, preceding)
          : partitionPinnedTabOrder([...tabOrder, id], tabs, id)
      } else {
        tabOrder = [...tabOrder, id]
      }
    }
    return { ...group, tabOrder, activeTabId: input.activate ? id : group.activeTabId }
  })
  return {
    ...existing,
    worktree: input.workspaceId,
    publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId: input.activate
      ? (groupId ?? null)
      : (existing?.activeGroupId ?? groupId ?? null),
    activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
    activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
    tabGroups,
    tabs
  }
}
