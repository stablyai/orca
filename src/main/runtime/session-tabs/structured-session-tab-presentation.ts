import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionAgentTab,
  RuntimeSessionTabCloseReason
} from '../../../shared/runtime-types'
import { closeRenderedStructuredSessionTab } from '../agent-session/structured-session-renderer-close'
import {
  captureInstalledStructuredSessionSurface,
  closeCapturedStructuredSession,
  type StructuredSessionSurfaceRuntime
} from '../agent-session/structured-agent-session-close'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionTabCloseCause } from '../agent-session/structured-agent-session-tab-close-cause'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import type { QueuedChatTabChange } from '../agent-session-tab-layout-queue'

type Surface = { worktreeId: string; tabId: string }

export function captureStructuredSessionPresentation(
  sessionId: string,
  input: {
    raw: Surface | null
    saved: NonNullable<WorkspaceSessionState['unifiedTabs']>
    pending: readonly QueuedChatTabChange[]
  }
): { raw: Surface | null; saved: Surface[] } {
  const saved = Object.entries(input.saved).flatMap(([worktreeId, tabs]) =>
    tabs.flatMap((tab) =>
      savedSessionId(tab) === sessionId ? [{ worktreeId, tabId: tab.id }] : []
    )
  )
  for (const queued of input.pending) {
    if ('open' in queued.change && queued.change.open.sessionId === sessionId) {
      saved.push({ worktreeId: queued.worktreeId, tabId: queued.change.open.tabId })
    }
  }
  return { raw: input.raw, saved }
}

/** Resolve only captured IDs at queue execution, including opens already queued at capture. */
export function capturedStructuredSessionSavedTabChanges(
  sessionId: string,
  targets: readonly Surface[],
  deps: {
    sessionOf: (worktreeId: string) => WorkspaceSessionState | null
    currentRaw: () => Surface | null
    eligible: () => boolean
  }
): () => QueuedChatTabChange[] {
  const eligible = () => {
    try {
      return deps.currentRaw() === null && deps.eligible()
    } catch {
      return false
    }
  }
  const byWorktree = new Map<string, Set<string>>()
  for (const target of targets) {
    const ids = byWorktree.get(target.worktreeId) ?? new Set<string>()
    ids.add(target.tabId)
    byWorktree.set(target.worktreeId, ids)
  }
  return () =>
    [...byWorktree].flatMap(([worktreeId, ids]) => {
      const tab = deps
        .sessionOf(worktreeId)
        ?.unifiedTabs?.[worktreeId]?.find(
          (candidate) => savedSessionId(candidate) === sessionId && ids.has(candidate.id)
        )
      return tab ? [{ worktreeId, change: { close: sessionId, tabId: tab.id }, eligible }] : []
    })
}

export function windowlessStructuredSessionTabSaveEligible(
  sessionId: string,
  tabId: string,
  session: WorkspaceSessionState | null,
  worktreeId: string
): boolean {
  const current = getStructuredAgentSessionHost()?.getSessionTabId(sessionId)
  if (isReopenedChatTabId(tabId)) {
    return current === tabId
  }
  if (current) {
    return !isReopenedChatTabId(current)
  }
  const saved = session?.unifiedTabs?.[worktreeId]?.find((tab) => savedSessionId(tab) === sessionId)
  return !saved || !isReopenedChatTabId(saved.id)
}

/** Renderer acceptance retires only the admitted raw identity; unknown journal state proves no durable hide. */
export async function closeMobileStructuredSessionPresentation(input: {
  tab: RuntimeMobileSessionAgentTab
  worktreeId: string
  reason?: RuntimeSessionTabCloseReason
  local: () => boolean
  rows: () => RuntimeMobileSessionTabsSnapshot['tabs'] | undefined
  notifier: Parameters<typeof closeRenderedStructuredSessionTab>[0]
  runtime: StructuredSessionSurfaceRuntime
}): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  const hostlessRaw =
    !host && (input.reason === undefined || input.reason === 'user') && input.local()
  const surface = captureInstalledStructuredSessionSurface(input.tab.sessionId, input.runtime)
  await closeRenderedStructuredSessionTab(input.notifier, input.tab.id, input.worktreeId)
  if (hostlessRaw) {
    if (!getStructuredAgentSessionHost() && input.local()) {
      const rows = input.rows()
      const current = rows?.find(
        (row) => row.type === 'agent-session' && row.sessionId === input.tab.sessionId
      )
      if (rows && (!current || current.id === input.tab.id)) {
        input.runtime.retireStructuredAgentSessionTabFromSnapshot(
          input.tab.sessionId,
          input.tab.id,
          input.worktreeId
        )
      }
    }
    return false
  }
  if (getStructuredAgentSessionHost() !== host) {
    return false
  }
  return host
    ? closeCapturedStructuredSession(
        host,
        input.tab.sessionId,
        structuredAgentSessionTabCloseCause(input.reason),
        surface,
        input.runtime
      )
    : false
}
