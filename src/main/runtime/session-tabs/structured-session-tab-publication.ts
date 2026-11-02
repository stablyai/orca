import type { OrcaRuntimeService } from '../orca-runtime'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'
import type { StructuredSessionSurface } from '../agent-session/structured-agent-session-close'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { chatTabId } from '../agent-session/agent-session-tab-layout'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mobileChatTabId, newReopenedChatTabId } from '../agent-session/agent-session-tab-identity'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'

export type StructuredSessionTabPublicationInput = {
  workspaceId: string
  sessionId: string
  agent: StructuredAgentId
  activate: boolean
  navigation?: 'caller'
  capture?: (surface: StructuredSessionSurface) => void
  workspaceAuthority?: {
    check(): void
    current(): boolean
    committed(): void
    saving(work: Promise<void>): void
  }
  notify?: boolean
  /** The host tab id a create reserved; a session that already has a tab keeps its own. */
  tabId?: string
  /** This machine's window made the create; its own open places the tab. */
  placedByWindow?: boolean
  /** Where the creating paired client opens the chat. */
  placement?: { groupId?: string; afterTabId?: string }
}

/** Caller opens require a committed lifetime; legacy opens retain their best-effort Retry surface. */
export async function admitStructuredSessionTabPublication(
  input: Pick<
    StructuredSessionTabPublicationInput,
    'sessionId' | 'tabId' | 'navigation' | 'workspaceAuthority'
  >,
  restore: () => Promise<void>
): Promise<{ tabId: string; current: string | null; eligible: () => boolean }> {
  let host = getStructuredAgentSessionHost()
  let tabId = input.tabId ?? chatTabId(input.sessionId)
  let committed = false
  if (input.navigation === 'caller') {
    await restore()
    host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('Chat tab inventory is unavailable')
    }
    await host.setSessionTabVisibility(input.sessionId, true, newReopenedChatTabId(), {
      check: () => input.workspaceAuthority?.check(),
      capture: (winner) => {
        if (winner) {
          tabId = winner
        }
      }
    })
    committed = true
    input.workspaceAuthority?.committed()
    if (!tabId || host.getSessionTabId(input.sessionId) !== tabId) {
      throw new Error('Chat tab publication was superseded')
    }
  } else if (typeof host?.setSessionTabVisibility === 'function') {
    // Restore-index failures (newer records/disk errors) are reported without preventing tab open.
    const openingHost = host
    await openingHost
      .setSessionTabVisibility(input.sessionId, true, input.tabId, {
        check: () => input.workspaceAuthority?.check(),
        capture: (winner) => {
          if (winner) {
            tabId = winner
          }
        }
      })
      .then(() => {
        committed = true
        input.workspaceAuthority?.committed()
      })
      .catch((error: unknown) => {
        input.workspaceAuthority?.check()
        openingHost.deps.logger.warn('recording an opened chat tab failed', {
          scope: 'tab-visibility-open',
          sessionId: input.sessionId,
          error
        })
      })
  }
  const current = host?.getSessionTabId(input.sessionId)
  if (isReopenedChatTabId(tabId) ? current !== tabId : current && isReopenedChatTabId(current)) {
    throw new Error('Chat tab publication was superseded')
  }
  const authority = host
  const eligible = () => {
    if (
      input.workspaceAuthority?.current() === false ||
      getStructuredAgentSessionHost() !== authority
    ) {
      return false
    }
    const winner = authority?.getSessionTabId(input.sessionId)
    return committed
      ? winner === tabId
      : isReopenedChatTabId(tabId)
        ? winner === tabId
        : !winner || winner === tabId
  }
  return { tabId, current: current ?? null, eligible }
}

export type StructuredSessionRawPublicationInput = Pick<
  StructuredSessionTabPublicationInput,
  'workspaceId' | 'sessionId' | 'agent' | 'activate' | 'notify' | 'tabId'
> & { eligible?: () => boolean }

export function projectStructuredSessionTab(
  runtime: Pick<OrcaRuntimeService, 'mobileSessionTabsByWorktree' | 'storeMobileSessionSnapshot'>,
  input: StructuredSessionRawPublicationInput,
  emit: (snapshot: RuntimeMobileSessionTabsSnapshot) => void
): void {
  const existing = runtime.mobileSessionTabsByWorktree.get(input.workspaceId)
  const id =
    input.tabId && isReopenedChatTabId(input.tabId) ? input.tabId : mobileChatTabId(input.sessionId)
  if (existing?.tabs.some((tab) => tab.id === id)) {
    // Background republish does not write/emit; healing missing client mirrors needs activate or explicit republish.
    if (!input.activate) {
      if (input.eligible?.() === false) {
        throw new Error('Chat tab publication was superseded')
      }
      return
    }
    const priorGroups = existing.tabGroups ?? []
    const groupId =
      priorGroups.find((group) => group.tabOrder.includes(id))?.id ??
      (priorGroups.some((group) => group.id === existing.activeGroupId)
        ? existing.activeGroupId
        : priorGroups[0]?.id)
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      ...existing,
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId: groupId ?? existing.activeGroupId,
      activeTabId: id,
      activeTabType: 'agent-session',
      tabGroups: priorGroups.map((group) =>
        group.id === groupId ? { ...group, activeTabId: id } : group
      ),
      tabs: existing.tabs.map((tab) => ({ ...tab, isActive: tab.id === id }))
    }
    if (input.eligible?.() === false) {
      throw new Error('Chat tab publication was superseded')
    }
    const stored = runtime.storeMobileSessionSnapshot(input.workspaceId, snapshot)
    if (input.notify !== false) {
      emit(stored)
    }
    return
  }
  const snapshot = withStructuredSessionChatTabs(existing, input.workspaceId, [
    {
      type: 'agent-session',
      id,
      title: defaultAgentChatLabel(input.agent),
      sessionId: input.sessionId,
      agent: input.agent,
      isActive: input.activate
    }
  ])
  if (input.eligible?.() === false) {
    throw new Error('Chat tab publication was superseded')
  }
  const stored = runtime.storeMobileSessionSnapshot(input.workspaceId, snapshot)
  if (input.notify !== false) {
    emit(stored)
  }
}

/** `existing` with chat tabs added in one copy. A tab a group already lists keeps that place; the
 *  rest join the active (else first) group, or the default group when the frame lists none. An
 *  added tab marked active becomes the frame's active tab. */
export function withStructuredSessionChatTabs(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  workspaceId: string,
  added: readonly RuntimeMobileSessionAgentTab[]
): RuntimeMobileSessionTabsSnapshot {
  const activated = added.find((tab) => tab.isActive)?.id ?? null
  const tabs = [
    ...(existing?.tabs ?? []).map((candidate) =>
      activated ? { ...candidate, isActive: false } : candidate
    ),
    ...added
  ]
  // A frame can list no groups (a window's empty workspace); the chats then start the default one.
  const priorGroups = existing?.tabGroups?.length
    ? existing.tabGroups
    : [
        {
          id: getHeadlessMobileSessionGroupId(workspaceId),
          activeTabId: existing?.activeTabId ?? null,
          tabOrder: []
        }
      ]
  // Why: the window can list a chat before main restores its row; keep the place it gave it.
  const addedIds = new Set(added.map((tab) => tab.id))
  const listingGroupIds = new Map<string, string>()
  for (const group of priorGroups) {
    for (const tabId of group.tabOrder) {
      if (addedIds.has(tabId) && !listingGroupIds.has(tabId)) {
        listingGroupIds.set(tabId, group.id)
      }
    }
  }
  const targetGroupId = priorGroups.some((group) => group.id === existing?.activeGroupId)
    ? existing!.activeGroupId!
    : priorGroups[0]!.id
  const appended = added.filter((tab) => !listingGroupIds.has(tab.id)).map((tab) => tab.id)
  const groupId = (added[0] && listingGroupIds.get(activated ?? added[0].id)) ?? targetGroupId
  const tabGroups = priorGroups.map((group) =>
    (group.id === targetGroupId && appended.length) || (activated && group.id === groupId)
      ? {
          ...group,
          activeTabId: activated && group.id === groupId ? activated : group.activeTabId,
          tabOrder: group.id === targetGroupId ? [...group.tabOrder, ...appended] : group.tabOrder
        }
      : group
  )
  return {
    worktree: workspaceId,
    publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId: activated ? groupId : (existing?.activeGroupId ?? groupId),
    activeTabId: activated ?? existing?.activeTabId ?? null,
    activeTabType: activated ? 'agent-session' : (existing?.activeTabType ?? null),
    tabGroups,
    ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
    tabs
  }
}
