import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { randomUUID } from 'node:crypto'
import { isAgentSessionSurfaceTabId } from '../../../shared/agent-session/view/agent-session-surface-tab-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

const REOPENED_TAB_PREFIX = 'agent-chat-tab-v1-'

export function newReopenedChatTabId(): string {
  const id = `${REOPENED_TAB_PREFIX}${randomUUID()}`
  if (!isAgentSessionSurfaceTabId(id)) {
    throw new Error('Invalid chat tab identity')
  }
  return id
}

export function mobileChatTabId(sessionId: string): string {
  const id = getStructuredAgentSessionHost()?.getSessionTabId(sessionId)
  return id && isReopenedChatTabId(id) ? id : `agent-session:${sessionId}`
}

export function resolveChatTabActivation(
  tabs: readonly { id: string; type: string; sessionId?: string }[],
  tabId: string
): string {
  return (
    tabs.find((tab) => tab.type === 'agent-session' && `agent-session:${tab.sessionId}` === tabId)
      ?.id ?? tabId
  )
}

/** Reject predecessor focus claims; reconstruct the committed surface passively. */
export function reconcileChatTabIdentities(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return snapshot
  }
  const prior = new Map(
    existing?.tabs.flatMap((tab) =>
      tab.type === 'agent-session' ? [[tab.sessionId, tab] as const] : []
    )
  )
  const currentBySession = new Map<string, string | null>()
  const currentId = (sessionId: string) => {
    if (!currentBySession.has(sessionId)) {
      currentBySession.set(sessionId, host.getSessionTabId(sessionId))
    }
    return currentBySession.get(sessionId) ?? null
  }
  const priorById = new Map([...prior.values()].map((tab) => [tab.id, tab]))
  const listed = new Set(snapshot.tabs.map((tab) => tab.id))
  const removed = new Set<string>()
  const replacements = new Map<
    string,
    Extract<RuntimeMobileSessionTabsSnapshot['tabs'][number], { type: 'agent-session' }>
  >()
  const tabs = snapshot.tabs.filter((tab) => {
    if (tab.type !== 'agent-session') {
      return true
    }
    const current = currentId(tab.sessionId)
    if (
      current === tab.id ||
      (current && !isReopenedChatTabId(current) && !isReopenedChatTabId(tab.id)) ||
      (!current && !isReopenedChatTabId(tab.id))
    ) {
      return true
    }
    const record = host.deps.store.getConversation(tab.sessionId)
    if (
      record?.location.executionHostId !== 'local' ||
      record.location.workspaceId !== snapshot.worktree
    ) {
      return true
    }
    removed.add(tab.id)
    if (current && isReopenedChatTabId(current) && !listed.has(current)) {
      const live = prior.get(tab.sessionId)
      replacements.set(
        current,
        live?.id === current ? live : { ...tab, id: current, isActive: false }
      )
    }
    return false
  })
  const references = [
    snapshot.activeTabId,
    ...(snapshot.tabGroups ?? []).flatMap((group) => [
      group.activeTabId,
      ...group.tabOrder,
      ...(group.recentTabIds ?? [])
    ])
  ]
  const acceptedIds = new Set(tabs.map((tab) => tab.id))
  for (const id of references) {
    if (!id || acceptedIds.has(id)) {
      continue
    }
    const priorTab = priorById.get(id)
    const sessionId =
      priorTab?.sessionId ??
      (id.startsWith('agent-session:') ? id.slice('agent-session:'.length) : null)
    if (sessionId && priorTab) {
      const current = currentId(sessionId)
      if (
        current === id ||
        (current && !isReopenedChatTabId(current) && !isReopenedChatTabId(id))
      ) {
        continue
      }
    }
    if ((priorTab && id.startsWith('agent-session:')) || isReopenedChatTabId(id)) {
      removed.add(id)
    }
  }
  if (removed.size === 0) {
    return snapshot
  }
  tabs.push(...replacements.values())
  const ids = new Set(tabs.map((tab) => tab.id))
  const active =
    snapshot.activeTabId && removed.has(snapshot.activeTabId)
      ? (tabs.find((tab) => tab.id === existing?.activeTabId) ??
        tabs.find((tab) => tab.isActive) ??
        tabs[0])
      : tabs.find((tab) => tab.id === snapshot.activeTabId)
  const priorGroups = new Map(existing?.tabGroups?.map((group) => [group.id, group]))
  const groupOf = new Map(
    existing?.tabGroups?.flatMap((group) => group.tabOrder.map((id) => [id, group.id] as const))
  )
  const addedByGroup = new Map<string, string[]>()
  for (const id of replacements.keys()) {
    const groupId = groupOf.get(id) ?? snapshot.tabGroups?.[0]?.id
    if (groupId) {
      const added = addedByGroup.get(groupId) ?? []
      added.push(id)
      addedByGroup.set(groupId, added)
    }
  }
  return {
    ...snapshot,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id })),
    tabGroups: snapshot.tabGroups?.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !removed.has(id))
      tabOrder.push(...(addedByGroup.get(group.id) ?? []))
      const priorActive = priorGroups.get(group.id)?.activeTabId
      return {
        ...group,
        tabOrder,
        activeTabId:
          group.activeTabId && removed.has(group.activeTabId)
            ? priorActive && ids.has(priorActive)
              ? priorActive
              : null
            : group.activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => !removed.has(id))
      }
    })
  }
}
