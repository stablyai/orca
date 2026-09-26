// Adding chat tabs to a workspace's host snapshot: one publish, or a restarted host's whole list in
// one store write rather than one per tab.

import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { RuntimeMobileSessionAgentTab } from '../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'

export type StructuredAgentSessionTabToAppend = {
  sessionId: string
  agent: 'claude' | 'codex'
  replacesSessionId?: string
}

export function structuredAgentSessionSnapshotTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

/** The snapshot with each tab it does not already hold appended to the active group, or null when
 *  it already holds them all. `activate` makes the last appended tab the active one. */
export function appendStructuredAgentSessionTabs(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  workspaceId: string,
  tabs: readonly StructuredAgentSessionTabToAppend[],
  options: { activate: boolean }
): RuntimeMobileSessionTabsSnapshot | null {
  const held = new Set(existing?.tabs.map((tab) => tab.id))
  const added: RuntimeMobileSessionAgentTab[] = []
  for (const input of tabs) {
    const id = structuredAgentSessionSnapshotTabId(input.sessionId)
    if (held.has(id)) {
      continue
    }
    held.add(id)
    added.push({
      type: 'agent-session',
      id,
      title: defaultAgentChatLabel(input.agent),
      sessionId: input.sessionId,
      ...(input.replacesSessionId ? { replacesSessionId: input.replacesSessionId } : {}),
      agent: input.agent,
      isActive: false
    })
  }
  const last = added.at(-1)
  if (!last) {
    return null
  }
  const activeId = options.activate ? last.id : null
  if (activeId) {
    last.isActive = true
  }
  const priorGroups = existing?.tabGroups ?? [
    {
      id: getHeadlessMobileSessionGroupId(workspaceId),
      activeTabId: existing?.activeTabId ?? null,
      tabOrder: []
    }
  ]
  const groupId =
    priorGroups.find((group) => group.id === existing?.activeGroupId)?.id ?? priorGroups[0]!.id
  return {
    worktree: workspaceId,
    publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId: activeId ? groupId : (existing?.activeGroupId ?? groupId),
    activeTabId: activeId ?? existing?.activeTabId ?? null,
    activeTabType: activeId ? 'agent-session' : (existing?.activeTabType ?? null),
    tabGroups: priorGroups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            activeTabId: activeId ?? group.activeTabId,
            tabOrder: [...group.tabOrder, ...added.map((tab) => tab.id)]
          }
        : group
    ),
    ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
    tabs: [
      ...(existing?.tabs ?? []).map((tab) => (activeId ? { ...tab, isActive: false } : tab)),
      ...added
    ]
  }
}
