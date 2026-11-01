import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'

export function createdStructuredSessionTabSnapshot(
  input: { workspaceId: string; sessionId: string; agent: StructuredAgentId; activate: boolean },
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  id: string
): RuntimeMobileSessionTabsSnapshot {
  const tab: RuntimeMobileSessionAgentTab = {
    type: 'agent-session',
    id,
    title: defaultAgentChatLabel(input.agent),
    sessionId: input.sessionId,
    agent: input.agent,
    isActive: input.activate
  }
  const tabs = [...(existing?.tabs ?? [])].map((candidate) => ({
    ...candidate,
    isActive: input.activate ? false : candidate.isActive
  }))
  tabs.push(tab)
  const priorGroups = existing?.tabGroups ?? [
    {
      id: getHeadlessMobileSessionGroupId(input.workspaceId),
      activeTabId: existing?.activeTabId ?? null,
      tabOrder: []
    }
  ]
  // Why: the window can list the chat before main restores its row; keep the place it gave it.
  const listingGroupId = priorGroups.find((group) => group.tabOrder.includes(id))?.id
  const groupId =
    listingGroupId ??
    (priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id)
  const tabGroups = priorGroups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          activeTabId: input.activate ? id : group.activeTabId,
          tabOrder: listingGroupId ? group.tabOrder : [...group.tabOrder, id]
        }
      : group
  )
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: input.workspaceId,
    publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId: input.activate ? groupId : (existing?.activeGroupId ?? groupId),
    activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
    activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
    tabGroups,
    ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
    tabs
  }
  return snapshot
}
