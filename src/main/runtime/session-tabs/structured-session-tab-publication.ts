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
import {
  isReopenedChatTabId,
  publishesSameChatRow
} from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import {
  insertTabIdIntoOrder,
  partitionPinnedTabOrder
} from '../../../shared/workspace-layout/tab-order'
import { swapSessionTabContent } from './session-tab-content-swap'
import { logicalTabIdOf, tabBarIdOf } from '../../../shared/runtime-mobile-session-tab-contracts'

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
  placement?: { groupId?: string; afterTabId?: string; index?: number }
  /** A switch's open: refused once newer work supersedes it, and its tab write is awaited. */
  check?: () => void
  focusWindow?: boolean
  /** A switch's chat: the layout tab it now fills, whose rows it takes in place. */
  inTab?: string
  /** A split pane's switch: the tab the chat opens beside, whose selection it may take. */
  sourceTabId?: string
}

/** Caller opens require a committed lifetime; legacy opens retain their best-effort Retry surface. */
export async function admitStructuredSessionTabPublication(
  input: Pick<
    StructuredSessionTabPublicationInput,
    'sessionId' | 'tabId' | 'navigation' | 'workspaceAuthority' | 'check'
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
    const openingHost = host
    const opening = openingHost
      .setSessionTabVisibility(input.sessionId, true, input.tabId, {
        check: () => {
          input.workspaceAuthority?.check()
          input.check?.()
        },
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
    // A switch's open fails with its tab record; other restore-index failures (newer records/disk
    // errors) are reported without preventing tab open.
    await (input.check
      ? opening
      : opening.catch((error: unknown) => {
          input.workspaceAuthority?.check()
          openingHost.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        }))
  }
  const current = host?.getSessionTabId(input.sessionId)
  // Another lifetime recorded since (or this lifetime never recorded) supersedes the publication.
  if (!publishesSameChatRow(input.sessionId, current, tabId)) {
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
    return (
      winner === tabId ||
      (!committed && !winner && publishesSameChatRow(input.sessionId, null, tabId))
    )
  }
  return { tabId, current: current ?? null, eligible }
}

export type StructuredSessionRawPublicationInput = Pick<
  StructuredSessionTabPublicationInput,
  'workspaceId' | 'sessionId' | 'agent' | 'activate' | 'notify' | 'tabId' | 'placement' | 'inTab'
> & {
  eligible?: () => boolean
}

/** Publish membership; a listed chat keeps its place, a new one goes last or at its placement,
 *  and a switch's chat takes its tab's rows in place. */
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
  // The chat's layout tab, which a client keeps its own tab by through a switch.
  const logicalTabId = input.inTab ?? input.tabId ?? chatTabId(input.sessionId)
  const tab: RuntimeMobileSessionAgentTab = {
    type: 'agent-session',
    id,
    ...(logicalTabId !== id ? { logicalTabId } : {}),
    title: defaultAgentChatLabel(input.agent),
    sessionId: input.sessionId,
    agent: input.agent,
    isActive: input.activate
  }
  const swapped = input.inTab ? swapSessionTabContent(existing, input.inTab, tab) : null
  if (swapped) {
    if (input.eligible?.() === false) {
      throw new Error('Chat tab publication was superseded')
    }
    const stored = runtime.storeMobileSessionSnapshot(input.workspaceId, swapped)
    if (input.notify !== false) {
      emit(stored)
    }
    return
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
  // Placement names a layout tab; this snapshot's group orders name a terminal's tab by the
  // terminal, so a switched tab is found by the layout id its rows carry.
  const afterRow =
    input.placement?.afterTabId &&
    existing?.tabs.find((row) => logicalTabIdOf(row) === input.placement?.afterTabId)
  const placement = afterRow
    ? { ...input.placement, afterTabId: tabBarIdOf(afterRow) }
    : input.placement
  const groupId =
    listingGroupId ??
    priorGroups.find((group) => group.id === placement?.groupId)?.id ??
    priorGroups.find((group) => group.tabOrder.includes(placement?.afterTabId ?? ''))?.id ??
    (priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id)
  const tabGroups = priorGroups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          activeTabId: input.activate ? id : group.activeTabId,
          tabOrder: listingGroupId
            ? group.tabOrder
            : placedTabOrder(group.tabOrder, tabs, id, placement)
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
  if (input.eligible?.() === false) {
    throw new Error('Chat tab publication was superseded')
  }
  const stored = runtime.storeMobileSessionSnapshot(input.workspaceId, snapshot)
  if (input.notify !== false) {
    emit(stored)
  }
}

function placedTabOrder(
  tabOrder: readonly string[],
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'],
  id: string,
  placement: StructuredSessionTabPublicationInput['placement']
): string[] {
  const after = placement?.afterTabId
  if (after && tabOrder.includes(after)) {
    return insertTabIdIntoOrder(tabOrder, tabs, id, false, after)
  }
  if (placement?.index !== undefined) {
    const preceding = tabOrder[Math.max(0, Math.min(placement.index, tabOrder.length)) - 1]
    return preceding
      ? insertTabIdIntoOrder(tabOrder, tabs, id, false, preceding)
      : partitionPinnedTabOrder([...tabOrder, id], tabs, id)
  }
  return [...tabOrder, id]
}
