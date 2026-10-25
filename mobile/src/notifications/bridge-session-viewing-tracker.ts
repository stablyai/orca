import { createSessionTabsTabDeltaDecoder } from '../../../src/shared/session-tabs-tab-delta'
import { structuredAgentSessionPaneKey, structuredAgentSessionTabId } from '../../../src/shared/structured-agent-session-projection'
import type { BridgeClientMessage } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from '../session/mobile-session-route-types'
import { notificationPaneTab, sessionTabPaneKey } from '../session/notification-pane-tab'
import type { NotificationViewingWorkspace } from './notification-viewing-policy'

let inPageViewingSink: ((value: NotificationViewingWorkspace | null) => void) | null = null

export function registerBridgeSessionViewingSink(sink: (value: NotificationViewingWorkspace | null) => void): void {
  inPageViewingSink = sink
}

type SelectionMeta = { tabId?: string; leafId?: string; terminalHandle?: string; paneKey?: string; explicit?: boolean }
type TabsStreamMeta = { worktreeId: string; executionHost?: string; decoder: ReturnType<typeof createSessionTabsTabDeltaDecoder> }
export type BridgeWorktreeAgentSnapshot = { paneKey?: string; prompt?: string; lastAssistantMessage?: string | null }

export type HostBridgeSessionState = {
  tabsStreamsById: Map<string, TabsStreamMeta>
  tabsRequestsById: Map<string, { worktreeId: string; executionHost?: string }>
  worktreeListRequestsById: Set<string>
  tabsByWorktree: Map<string, readonly MobileSessionTab[]>
  worktreeAgentsByWorktree: Map<string, readonly BridgeWorktreeAgentSnapshot[]>
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined // SAFETY: narrowed to non-null object above
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

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
      tabsStreamsById: new Map(), tabsRequestsById: new Map(), worktreeListRequestsById: new Set(),
      tabsByWorktree: new Map(), worktreeAgentsByWorktree: new Map(), selectedByWorktree: new Map(), serverActiveTabByWorktree: new Map()
    }
    bridgeSessionByHostKey.set(hostKey, state)
  }
  return state
}

function stripWorktreePrefix(raw: unknown): string | undefined {
  const str = nonEmptyString(raw)
  return str?.startsWith('id:') ? str.slice('id:'.length) : str
}

function findMatchingTab(tabs: readonly MobileSessionTab[] | undefined, selection: SelectionMeta | undefined): MobileSessionTab | undefined {
  if (!tabs || tabs.length === 0) {
    return undefined
  }
  if (selection?.tabId) {
    const byTabId = tabs.find((tab) => tab.id === selection.tabId || (tab.type === 'terminal' && tab.parentTabId === selection.tabId && (!selection.leafId || tab.leafId === selection.leafId)))
    if (byTabId) {
      return byTabId
    }
  }
  if (selection?.terminalHandle) {
    const byHandle = tabs.find((tab) => tab.type === 'terminal' && tab.terminal === selection.terminalHandle)
    if (byHandle) {
      return byHandle
    }
  }
  return selection?.paneKey ? notificationPaneTab(tabs, selection.paneKey) : undefined
}

export function publishBridgeSessionViewing(hostId: string, state: HostBridgeSessionState): void {
  if (!state.worktreeId) {
    return
  }
  activeInPageHostKeys.add(normalizeHostKey(hostId))
  inPageViewingSink?.({ hostId, worktreeId: state.worktreeId, ...(state.executionHost ? { executionHost: state.executionHost } : {}), ...(state.paneKey ? { paneKey: state.paneKey } : {}) })
}

function recordTerminalSelection(hostId: string, state: HostBridgeSessionState, handle: string) {
  if (!state.worktreeId) {
    return
  }
  const matched = state.tabsByWorktree.get(state.worktreeId)?.find((tab) => tab.type === 'terminal' && tab.terminal === handle)
  const paneKey = sessionTabPaneKey(matched) ?? state.selectedByWorktree.get(state.worktreeId)?.paneKey ?? state.paneKey
  state.selectedByWorktree.set(state.worktreeId, {
    terminalHandle: handle,
    ...(matched ? { tabId: matched.id, ...(matched.type === 'terminal' && matched.leafId ? { leafId: matched.leafId } : {}) } : {}),
    ...(paneKey ? { paneKey } : {}),
    explicit: true
  })
  state.paneKey = paneKey ?? state.paneKey
  publishBridgeSessionViewing(hostId, state)
}

export function ingestBridgeWorktreeListPayload(hostId: string, payload: unknown): void {
  const state = getOrCreateBridgeSessionState(normalizeHostKey(hostId))
  const payloadObj = asRecord(payload)
  const worktrees = Array.isArray(payloadObj?.worktrees) ? payloadObj.worktrees : Array.isArray(payload) ? payload : null
  for (const item of worktrees ?? []) {
    const rec = asRecord(item)
    const wtId = nonEmptyString(rec?.worktreeId) ?? nonEmptyString(rec?.id)
    if (wtId && Array.isArray(rec?.agents)) {
      // SAFETY: worktree.ps / worktree.list returns agent snapshot objects with optional paneKey/prompt/lastAssistantMessage
      state.worktreeAgentsByWorktree.set(wtId, rec.agents as readonly BridgeWorktreeAgentSnapshot[])
    }
  }
}

export function noteBridgeHostClientMessage(hostId: string, message: BridgeClientMessage, isConnected: () => boolean): void {
  const hostKey = normalizeHostKey(hostId)
  const state = getOrCreateBridgeSessionState(hostKey)
  if (message.type === 'request' && (message.method === 'worktree.list' || message.method === 'worktree.ps')) {
    state.worktreeListRequestsById.add(message.id)
    return
  }
  const params = 'params' in message ? asRecord(message.params) : undefined
  if ((message.type === 'subscribe' && message.method === 'session.tabs.subscribe') || (message.type === 'request' && message.method === 'session.tabs.list')) {
    const worktreeId = stripWorktreePrefix(params?.worktree)
    if (!worktreeId) {
      return
    }
    const executionHost = nonEmptyString(message.envelope?.executionHost)
    if (message.type === 'subscribe') {
      clearTimeout(state.pendingClear)
      state.pendingClear = undefined
      state.tabsStreamsById.set(message.id, { worktreeId, ...(executionHost ? { executionHost } : {}), decoder: createSessionTabsTabDeltaDecoder() })
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
      const matched = findMatchingTab(tabs, selected) ?? (selected?.paneKey ? undefined : (tabs?.find((tab) => tab.isActive) ?? tabs?.[0]))
      state.paneKey = selected?.paneKey ?? sessionTabPaneKey(matched)
    }
    publishBridgeSessionViewing(hostId, state)
    return
  }
  if (message.type === 'request' && message.method === 'session.tabs.activate') {
    const worktreeId = stripWorktreePrefix(params?.worktree) ?? state.worktreeId
    const tabId = nonEmptyString(params?.tabId)
    const leafId = nonEmptyString(params?.leafId)
    if (!worktreeId || !tabId) {
      return
    }
    const nextSelection: SelectionMeta = { tabId, ...(leafId ? { leafId } : {}) }
    const matched = findMatchingTab(state.tabsByWorktree.get(worktreeId), nextSelection)
    const paneKey = sessionTabPaneKey(matched) ?? (leafId ? `${tabId}:${leafId}` : `terminal:${tabId}`)
    state.selectedByWorktree.set(worktreeId, {
      ...nextSelection,
      ...(matched?.type === 'terminal' && typeof matched.terminal === 'string' ? { terminalHandle: matched.terminal } : {}),
      paneKey,
      explicit: true
    })
    state.worktreeId = worktreeId
    state.executionHost = nonEmptyString(message.envelope?.executionHost) ?? state.executionHost
    state.paneKey = paneKey
    publishBridgeSessionViewing(hostId, state)
    return
  }
  if ((message.type === 'subscribe' && message.method === 'terminal.subscribe') || (message.type === 'request' && (message.method === 'terminal.send' || message.method === 'terminal.focus'))) {
    const handle = nonEmptyString(params?.handle) ?? nonEmptyString(params?.terminal)
    if (handle) {
      recordTerminalSelection(hostId, state, handle)
    }
    return
  }
  if ((message.type === 'subscribe' && message.method === 'agentSession.subscribe') || (message.type === 'request' && (message.method === 'agentSession.send' || message.method === 'agentSession.commands' || message.method === 'agentSession.options'))) {
    const sessionId = nonEmptyString(params?.sessionId)?.trim()
    if (sessionId && state.worktreeId) {
      const tabId = structuredAgentSessionTabId(sessionId)
      const paneKey = structuredAgentSessionPaneKey(tabId, sessionId)
      state.selectedByWorktree.set(state.worktreeId, { tabId, paneKey, explicit: true })
      state.paneKey = paneKey
      publishBridgeSessionViewing(hostId, state)
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
      if (state.tabsStreamsById.size === 0 && isConnected() && (mountedSessionRouteBridgesByKey.get(hostKey) ?? 0) === 0) {
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
  if (state.worktreeListRequestsById.delete(id)) {
    ingestBridgeWorktreeListPayload(hostId, payload)
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
  const resolvedPayload = asRecord(decoded.ok ? decoded.result : payload)
  if (!resolvedPayload || !Array.isArray(resolvedPayload.tabs)) {
    return
  }
  // SAFETY: session.tabs.list / session.tabs.subscribe payloads carry MobileSessionTab[]
  const tabs = resolvedPayload.tabs as readonly MobileSessionTab[]
  state.tabsByWorktree.set(meta.worktreeId, tabs)
  const existing = state.selectedByWorktree.get(meta.worktreeId)
  const serverActiveTabId = nonEmptyString(resolvedPayload.activeTabId)
  const serverActive = (serverActiveTabId ? tabs.find((tab) => tab.id === serverActiveTabId) : undefined) ?? tabs.find((tab) => tab.isActive)
  const prevServerActiveId = state.serverActiveTabByWorktree.get(meta.worktreeId)
  if (serverActive) {
    state.serverActiveTabByWorktree.set(meta.worktreeId, serverActive.id)
  }
  const serverActiveChanged = serverActive !== undefined && prevServerActiveId !== undefined && serverActive.id !== prevServerActiveId
  const followsHost = resolvedPayload.navigationIntent === 'follow' || (serverActiveChanged && !existing?.explicit)
  const explicitMatch = followsHost ? undefined : findMatchingTab(tabs, existing)
  const preserveUnmatchedSelection = !followsHost && !explicitMatch && Boolean(existing?.paneKey)
  const matched = explicitMatch ?? (preserveUnmatchedSelection ? undefined : (serverActive ?? tabs[0]))
  const paneKey = sessionTabPaneKey(matched) ?? existing?.paneKey
  if (matched && paneKey) {
    state.selectedByWorktree.set(meta.worktreeId, {
      ...(explicitMatch ? existing : {}),
      tabId: matched.id,
      ...(matched.type === 'terminal' && matched.leafId ? { leafId: matched.leafId } : {}),
      ...(matched.type === 'terminal' && typeof matched.terminal === 'string' ? { terminalHandle: matched.terminal } : {}),
      paneKey,
      ...(explicitMatch && existing?.explicit ? { explicit: true } : {})
    })
  }
  if (!state.worktreeId || state.worktreeId === meta.worktreeId) {
    state.worktreeId = meta.worktreeId
    state.executionHost = meta.executionHost ?? state.executionHost
    state.paneKey = paneKey
    publishBridgeSessionViewing(hostId, state)
  }
}

export function readBridgeNotificationAgentContext(
  hostId: string,
  worktreeId?: string,
  paneKey?: string
): { prompt?: string; lastAssistantMessage?: string } {
  if (!worktreeId) {
    return {}
  }
  const primary = bridgeSessionByHostKey.get(normalizeHostKey(hostId))
  const states = new Set<HostBridgeSessionState>(primary ? [primary, ...bridgeSessionByHostKey.values()] : bridgeSessionByHostKey.values())
  let prompt: string | undefined
  let lastAssistantMessage: string | undefined
  for (const state of states) {
    const tabs = state.tabsByWorktree.get(worktreeId)
    const tab = tabs ? (paneKey ? notificationPaneTab(tabs, paneKey) : tabs.find((t) => t.type === 'terminal' && Boolean(t.agentStatus))) : undefined
    if (tab?.type === 'terminal' && tab.agentStatus) {
      const historyPrompt = tab.agentStatus.stateHistory
        ?.findLast((entry) => typeof entry.prompt === 'string' && entry.prompt.trim().length > 0)
        ?.prompt?.trim()
      prompt = prompt ?? (tab.agentStatus.prompt?.trim() || historyPrompt || undefined)
      const reply = tab.agentStatus.lastAssistantMessage ?? tab.agentStatus.lastCompletedAssistantMessage
      lastAssistantMessage = lastAssistantMessage ?? (reply?.trim() || undefined)
    }
    const agents = state.worktreeAgentsByWorktree.get(worktreeId)
    const leaf = paneKey?.includes(':') ? paneKey.slice(paneKey.lastIndexOf(':') + 1) : undefined
    const agent = agents?.length
      ? (paneKey
          ? (agents.find((a) => a.paneKey === paneKey) ?? (leaf ? agents.find((a) => typeof a.paneKey === 'string' && a.paneKey.endsWith(`:${leaf}`)) : undefined))
          : agents[0])
      : undefined
    prompt = prompt ?? nonEmptyString(agent?.prompt?.trim())
    lastAssistantMessage = lastAssistantMessage ?? nonEmptyString(agent?.lastAssistantMessage?.trim())
    if (prompt && lastAssistantMessage) {
      break
    }
  }
  return { ...(prompt ? { prompt } : {}), ...(lastAssistantMessage ? { lastAssistantMessage } : {}) }
}
