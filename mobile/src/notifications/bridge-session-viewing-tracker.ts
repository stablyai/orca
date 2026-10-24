import { createSessionTabsTabDeltaDecoder } from '../../../src/shared/session-tabs-tab-delta'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { BridgeClientMessage } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from '../session/mobile-session-route-types'
import { notificationPaneTab, sessionTabPaneKey } from '../session/notification-pane-tab'
import type { NotificationViewingWorkspace } from './notification-viewing-policy'

let inPageViewingSink: ((value: NotificationViewingWorkspace | null) => void) | null = null

export function registerBridgeSessionViewingSink(
  sink: (value: NotificationViewingWorkspace | null) => void
): void {
  inPageViewingSink = sink
}

type SelectionMeta = {
  tabId?: string
  leafId?: string
  terminalHandle?: string
  paneKey?: string
  explicit?: boolean
}

type TabsStreamMeta = {
  worktreeId: string
  executionHost?: string
  decoder: ReturnType<typeof createSessionTabsTabDeltaDecoder>
}

export type HostBridgeSessionState = {
  tabsStreamsById: Map<string, TabsStreamMeta>
  tabsRequestsById: Map<string, { worktreeId: string; executionHost?: string }>
  tabsByWorktree: Map<string, readonly MobileSessionTab[]>
  selectedByWorktree: Map<string, SelectionMeta>
  serverActiveTabByWorktree: Map<string, string>
  worktreeId?: string
  executionHost?: string
  paneKey?: string
  pendingClear?: ReturnType<typeof setTimeout>
}

// Why: the page re-subscribes its tabs stream on re-render; clearing on the gap made viewing
// fall back to the desktop's active tab exactly when a completion notification arrived.
export const TABS_STREAM_CLEAR_GRACE_MS = 1500

export const activeInPageHostKeys = new Set<string>()
export const mountedSessionRouteBridgesByKey = new Map<string, number>()
export const bridgeSessionByHostKey = new Map<string, HostBridgeSessionState>()

export function normalizeHostKey(hostId: string): string {
  try {
    return decodeURIComponent(hostId)
  } catch {
    return hostId
  }
}

export function getOrCreateBridgeSessionState(hostKey: string): HostBridgeSessionState {
  let state = bridgeSessionByHostKey.get(hostKey)
  if (!state) {
    state = {
      tabsStreamsById: new Map(),
      tabsRequestsById: new Map(),
      tabsByWorktree: new Map(),
      selectedByWorktree: new Map(),
      serverActiveTabByWorktree: new Map()
    }
    bridgeSessionByHostKey.set(hostKey, state)
  }
  return state
}

function stripWorktreePrefix(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined
  }
  return raw.startsWith('id:') ? raw.slice('id:'.length) : raw
}

function findMatchingTab(
  tabs: readonly MobileSessionTab[] | undefined,
  selection: SelectionMeta | undefined
): MobileSessionTab | undefined {
  if (!tabs || tabs.length === 0) {
    return undefined
  }
  if (selection?.tabId) {
    const byTabId = tabs.find(
      (tab) =>
        tab.id === selection.tabId ||
        (tab.type === 'terminal' &&
          tab.parentTabId === selection.tabId &&
          (!selection.leafId || tab.leafId === selection.leafId))
    )
    if (byTabId) {
      return byTabId
    }
  }
  if (selection?.terminalHandle) {
    const byHandle = tabs.find(
      (tab) => tab.type === 'terminal' && tab.terminal === selection.terminalHandle
    )
    if (byHandle) {
      return byHandle
    }
  }
  if (selection?.paneKey) {
    return notificationPaneTab(tabs, selection.paneKey)
  }
  return undefined
}

export function publishBridgeSessionViewing(hostId: string, state: HostBridgeSessionState): void {
  if (!state.worktreeId) {
    return
  }
  activeInPageHostKeys.add(normalizeHostKey(hostId))
  inPageViewingSink?.({
    hostId,
    worktreeId: state.worktreeId,
    ...(state.executionHost ? { executionHost: state.executionHost } : {}),
    ...(state.paneKey ? { paneKey: state.paneKey } : {})
  })
}

function recordTerminalSelection(hostId: string, state: HostBridgeSessionState, handle: string) {
  if (!state.worktreeId) {
    return
  }
  const matched = state.tabsByWorktree
    .get(state.worktreeId)
    ?.find((tab) => tab.type === 'terminal' && tab.terminal === handle)
  const paneKey =
    sessionTabPaneKey(matched) ??
    state.selectedByWorktree.get(state.worktreeId)?.paneKey ??
    state.paneKey
  state.selectedByWorktree.set(state.worktreeId, {
    terminalHandle: handle,
    ...(matched
      ? {
          tabId: matched.id,
          ...(matched.type === 'terminal' && matched.leafId ? { leafId: matched.leafId } : {})
        }
      : {}),
    ...(paneKey ? { paneKey } : {}),
    explicit: true
  })
  if (paneKey) {
    state.paneKey = paneKey
  }
  publishBridgeSessionViewing(hostId, state)
}

function recordAgentSessionSelection(
  hostId: string,
  state: HostBridgeSessionState,
  sessionId: string
): void {
  if (!state.worktreeId) {
    return
  }
  const tabId = structuredAgentSessionTabId(sessionId)
  const paneKey = structuredAgentSessionPaneKey(tabId, sessionId)
  state.selectedByWorktree.set(state.worktreeId, { tabId, paneKey, explicit: true })
  state.paneKey = paneKey
  publishBridgeSessionViewing(hostId, state)
}

export function noteBridgeHostClientMessage(
  hostId: string,
  message: BridgeClientMessage,
  isConnected: () => boolean
): void {
  const hostKey = normalizeHostKey(hostId)
  const state = getOrCreateBridgeSessionState(hostKey)
  if (
    (message.type === 'subscribe' && message.method === 'session.tabs.subscribe') ||
    (message.type === 'request' && message.method === 'session.tabs.list')
  ) {
    const worktreeId = stripWorktreePrefix((message.params as { worktree?: unknown } | undefined)?.worktree)
    if (!worktreeId) {
      return
    }
    const rawExec = message.envelope?.executionHost
    const executionHost = typeof rawExec === 'string' && rawExec.length > 0 ? rawExec : undefined
    if (message.type === 'subscribe') {
      clearTimeout(state.pendingClear)
      state.pendingClear = undefined
      state.tabsStreamsById.set(message.id, {
        worktreeId,
        ...(executionHost ? { executionHost } : {}),
        decoder: createSessionTabsTabDeltaDecoder()
      })
    } else {
      state.tabsRequestsById.set(message.id, { worktreeId, ...(executionHost ? { executionHost } : {}) })
      if (state.worktreeId && state.worktreeId !== worktreeId) {
        return
      }
    }
    const worktreeChanged = state.worktreeId !== worktreeId
    state.worktreeId = worktreeId
    state.executionHost = executionHost
    if (worktreeChanged) {
      const selected = state.selectedByWorktree.get(worktreeId)
      const tabs = state.tabsByWorktree.get(worktreeId)
      const matched =
        findMatchingTab(tabs, selected) ??
        (selected?.paneKey ? undefined : (tabs?.find((tab) => tab.isActive) ?? tabs?.[0]))
      state.paneKey = selected?.paneKey ?? sessionTabPaneKey(matched)
    }
    publishBridgeSessionViewing(hostId, state)
    return
  }

  if (message.type === 'request' && message.method === 'session.tabs.activate') {
    const params = message.params as { worktree?: unknown; tabId?: unknown; leafId?: unknown } | undefined
    const worktreeId = stripWorktreePrefix(params?.worktree) ?? state.worktreeId
    const tabId = typeof params?.tabId === 'string' && params.tabId.length > 0 ? params.tabId : undefined
    const leafId = typeof params?.leafId === 'string' && params.leafId.length > 0 ? params.leafId : undefined
    if (!worktreeId || !tabId) {
      return
    }
    const nextSelection: SelectionMeta = { tabId, ...(leafId ? { leafId } : {}) }
    const matched = findMatchingTab(state.tabsByWorktree.get(worktreeId), nextSelection)
    const paneKey = sessionTabPaneKey(matched) ?? (leafId ? `${tabId}:${leafId}` : `terminal:${tabId}`)
    state.selectedByWorktree.set(worktreeId, {
      ...nextSelection,
      ...(matched?.type === 'terminal' && typeof matched.terminal === 'string'
        ? { terminalHandle: matched.terminal }
        : {}),
      paneKey,
      explicit: true
    })
    state.worktreeId = worktreeId
    const rawExec = message.envelope?.executionHost
    if (typeof rawExec === 'string' && rawExec.length > 0) {
      state.executionHost = rawExec
    }
    state.paneKey = paneKey
    publishBridgeSessionViewing(hostId, state)
    return
  }

  if (
    (message.type === 'subscribe' && message.method === 'terminal.subscribe') ||
    (message.type === 'request' &&
      (message.method === 'terminal.send' || message.method === 'terminal.focus'))
  ) {
    const params = message.params as { handle?: unknown; terminal?: unknown } | undefined
    const handle =
      typeof params?.handle === 'string' && params.handle.length > 0
        ? params.handle
        : typeof params?.terminal === 'string' && params.terminal.length > 0
          ? params.terminal
          : undefined
    if (handle) {
      recordTerminalSelection(hostId, state, handle)
    }
    return
  }

  if (
    (message.type === 'subscribe' && message.method === 'agentSession.subscribe') ||
    (message.type === 'request' &&
      (message.method === 'agentSession.send' ||
        message.method === 'agentSession.commands' ||
        message.method === 'agentSession.options'))
  ) {
    const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
      recordAgentSessionSelection(hostId, state, sessionId.trim())
    }
    return
  }

  if (message.type === 'cancel' && message.target === 'subscription') {
    if (!state.tabsStreamsById.delete(message.id) || state.tabsStreamsById.size > 0) {
      return
    }
    clearTimeout(state.pendingClear)
    state.pendingClear = setTimeout(() => {
      state.pendingClear = undefined
      if (
        state.tabsStreamsById.size === 0 &&
        isConnected() &&
        (mountedSessionRouteBridgesByKey.get(hostKey) ?? 0) === 0
      ) {
        state.worktreeId = undefined
        state.paneKey = undefined
        state.selectedByWorktree.clear()
        state.serverActiveTabByWorktree.clear()
        activeInPageHostKeys.delete(hostKey)
        inPageViewingSink?.(null)
      }
    }, TABS_STREAM_CLEAR_GRACE_MS)
  }
}

export function noteBridgeHostServerPayload(hostId: string, id: string, payload: unknown): void {
  const state = bridgeSessionByHostKey.get(normalizeHostKey(hostId))
  if (!state) {
    return
  }
  const streamMeta = state.tabsStreamsById.get(id)
  const requestMeta = state.tabsRequestsById.get(id)
  state.tabsRequestsById.delete(id)
  const meta = streamMeta ?? requestMeta
  if (!meta || !payload || typeof payload !== 'object') {
    return
  }
  const decoded = streamMeta ? streamMeta.decoder.decode(payload) : { ok: true as const, result: payload }
  const resolvedPayload = (decoded.ok ? decoded.result : payload) as {
    activeTabId?: unknown
    navigationIntent?: unknown
    tabs?: unknown
  }
  if (!Array.isArray(resolvedPayload.tabs)) {
    return
  }
  const tabs = resolvedPayload.tabs as readonly MobileSessionTab[]
  state.tabsByWorktree.set(meta.worktreeId, tabs)
  const existing = state.selectedByWorktree.get(meta.worktreeId)
  const serverActiveTabId =
    typeof resolvedPayload.activeTabId === 'string' && resolvedPayload.activeTabId.length > 0
      ? resolvedPayload.activeTabId
      : undefined
  const serverActive =
    (serverActiveTabId ? tabs.find((tab) => tab.id === serverActiveTabId) : undefined) ??
    tabs.find((tab) => tab.isActive)
  const prevServerActiveId = state.serverActiveTabByWorktree.get(meta.worktreeId)
  if (serverActive) {
    state.serverActiveTabByWorktree.set(meta.worktreeId, serverActive.id)
  }
  const serverActiveChanged =
    serverActive !== undefined &&
    prevServerActiveId !== undefined &&
    serverActive.id !== prevServerActiveId
  const followsHost =
    resolvedPayload.navigationIntent === 'follow' || (serverActiveChanged && !existing?.explicit)
  const explicitMatch = followsHost ? undefined : findMatchingTab(tabs, existing)
  const preserveUnmatchedSelection = !followsHost && !explicitMatch && Boolean(existing?.paneKey)
  const matched =
    explicitMatch ?? (preserveUnmatchedSelection ? undefined : (serverActive ?? tabs[0]))
  const paneKey = sessionTabPaneKey(matched) ?? existing?.paneKey
  if (matched && paneKey) {
    state.selectedByWorktree.set(meta.worktreeId, {
      ...(explicitMatch ? existing : {}),
      tabId: matched.id,
      ...(matched.type === 'terminal' && matched.leafId ? { leafId: matched.leafId } : {}),
      ...(matched.type === 'terminal' && typeof matched.terminal === 'string'
        ? { terminalHandle: matched.terminal }
        : {}),
      paneKey,
      ...(explicitMatch && existing?.explicit ? { explicit: true } : {})
    })
  }
  if (!state.worktreeId || state.worktreeId === meta.worktreeId) {
    state.worktreeId = meta.worktreeId
    if (meta.executionHost) {
      state.executionHost = meta.executionHost
    }
    state.paneKey = paneKey
    publishBridgeSessionViewing(hostId, state)
  }
}
