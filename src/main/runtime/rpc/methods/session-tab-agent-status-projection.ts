import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import {
  clientRendersStructuredAgent,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

type SessionTabsPayload = RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot

/** Capped at 128px / one line in every shipped mobile build, so ~15-18 characters render. */
export const STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE = 'Update to view'
export const CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE = 'Open on desktop'

function clientCanRenderStructuredAgentSessionTab(
  tab: RuntimeMobileSessionAgentTab,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): boolean {
  // Legacy clients render only Claude/Codex chats; require explicit support for other agents to avoid empty panes.
  return clientRendersStructuredAgent(clientCapabilities, tab.agent)
}

function resolveMobileStructuredChatFallbackTitle(
  tab: RuntimeMobileSessionAgentTab,
  args: {
    clientKind: 'mobile' | 'runtime' | undefined
    clientCapabilities: readonly RuntimeCapability[] | undefined
  }
): string | null {
  if (
    args.clientKind !== 'mobile' ||
    clientCanRenderStructuredAgentSessionTab(tab, args.clientCapabilities)
  ) {
    return null
  }
  return tab.agent === 'claude'
    ? CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE
    : STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE
}

export function projectSessionTabAgentStatus<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): TPayload {
  const structuredVisible = supportsStructuredAgentSessions({ clientKind, clientCapabilities })
  let projected: TPayload
  if (clientKind === 'mobile') {
    // Keep an actionable fallback row so the chat is discoverable; retaining it needs no layout repair.
    projected = projectUnsupportedAgentSessionTabTitles(payload, {
      clientKind,
      clientCapabilities
    })
  } else {
    projected = structuredVisible ? payload : projectAgentSessionTabsOut(payload, () => true)
    // Gate chat rows by client rendering support or selection opens neither chat nor terminal.
    if (structuredVisible && clientKind !== undefined) {
      projected = projectAgentSessionTabsOut(
        projected,
        (tab) => !clientCanRenderStructuredAgentSessionTab(tab, clientCapabilities)
      )
    }
  }
  if (
    clientKind !== undefined &&
    !clientCapabilities?.includes(AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY)
  ) {
    projected = projectRestoredAgentStatusAsLegacyDone(projected)
  }
  // Legacy done completion applies only to paired runtimes; mobile retains rows without changing v2 authentication.
  if (
    clientKind !== 'runtime' ||
    clientCapabilities?.includes(AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY)
  ) {
    return projected
  }

  let changed = false
  const tabs = projected.tabs.map((tab) => {
    if (tab.type !== 'terminal' || !tab.agentStatus?.sessionBoundary) {
      return tab
    }
    changed = true
    const { agentStatus: _boundary, ...legacyTab } = tab
    return legacyTab
  })
  return changed ? ({ ...projected, tabs } as TPayload) : projected
}

/** What hosts published for a restored turn before clients could read it as unverifiable. */
function projectRestoredAgentStatusAsLegacyDone<TPayload extends SessionTabsPayload>(
  payload: TPayload
): TPayload {
  let changed = false
  const tabs = payload.tabs.map((tab) => {
    if (tab.type !== 'terminal' || tab.agentStatus?.restoredUnconfirmed !== true) {
      return tab
    }
    changed = true
    const { restoredUnconfirmed: _restored, ...legacyStatus } = tab.agentStatus
    return { ...tab, agentStatus: { ...legacyStatus, state: 'done' as const, prompt: '' } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only terminal tabs' agentStatus changed; every other TPayload field is spread through unchanged.
  return changed ? ({ ...payload, tabs } as TPayload) : payload
}

function projectUnsupportedAgentSessionTabTitles<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  args: {
    clientKind: 'mobile'
    clientCapabilities: readonly RuntimeCapability[] | undefined
  }
): TPayload {
  let changed = false
  const tabs = payload.tabs.map((tab) => {
    if (tab.type !== 'agent-session') {
      return tab
    }
    const title = resolveMobileStructuredChatFallbackTitle(tab, args)
    if (title === null) {
      return tab
    }
    changed = true
    return { ...tab, title }
  })
  return changed ? ({ ...payload, tabs } as TPayload) : payload
}

export function assertAgentSessionTabDestructiveMutationSupported(
  payload: SessionTabsPayload,
  tabId: string,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): void {
  if (clientKind === undefined) {
    return
  }
  const tab = payload.tabs.find((candidate) => candidate.id === tabId)
  if (
    tab?.type === 'agent-session' &&
    !clientCanRenderStructuredAgentSessionTab(tab, clientCapabilities)
  ) {
    throw new Error('structured_agent_session_unsupported')
  }
}

function projectAgentSessionTabsOut<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  shouldHide: (tab: RuntimeMobileSessionAgentTab) => boolean
): TPayload {
  const hiddenIds = new Set(
    payload.tabs
      .filter(
        (tab): tab is RuntimeMobileSessionAgentTab =>
          tab.type === 'agent-session' && shouldHide(tab)
      )
      .map((tab) => tab.id)
  )
  if (hiddenIds.size === 0) {
    return payload
  }
  const tabs = payload.tabs.filter((tab) => !hiddenIds.has(tab.id))
  const groups = payload.tabGroups
    ?.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !hiddenIds.has(id))
      if (tabOrder.length === 0) {
        return null
      }
      const recentTabIds = group.recentTabIds?.filter((id) => !hiddenIds.has(id))
      return {
        ...group,
        activeTabId:
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (recentTabIds?.find((id) => tabOrder.includes(id)) ?? tabOrder[0] ?? null),
        tabOrder,
        ...(recentTabIds ? { recentTabIds } : {})
      }
    })
    .filter((group): group is NonNullable<typeof group> => group !== null)
  const active =
    tabs.find((tab) => tab.id === payload.activeTabId) ??
    tabs.find((tab) => tab.isActive) ??
    tabs[0] ??
    null
  const validGroupIds = new Set(groups?.map((group) => group.id) ?? [])
  return {
    ...payload,
    activeGroupId:
      groups?.find((group) => group.tabOrder.includes(active?.id ?? ''))?.id ??
      groups?.[0]?.id ??
      null,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(groups ? { tabGroups: groups } : { tabGroups: undefined }),
    ...(payload.tabGroupLayout !== undefined
      ? { tabGroupLayout: pruneStructuredTabGroupLayout(payload.tabGroupLayout, validGroupIds) }
      : {}),
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id }))
  } as TPayload
}

function pruneStructuredTabGroupLayout(
  layout: TabGroupLayoutNode | null,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout || layout.type === 'leaf') {
    return layout && validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneStructuredTabGroupLayout(layout.first, validGroupIds)
  const second = pruneStructuredTabGroupLayout(layout.second, validGroupIds)
  return first && second ? { ...layout, first, second } : (first ?? second)
}
