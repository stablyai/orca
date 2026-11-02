import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../shared/stable-pane-id'

// Renderer snapshots omit runtime-owned fields; Store must preserve them, including before-unload writes.
function unionWriteOnceDefaultTerminalTabsApplied(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  const priorMarks = prior?.defaultTerminalTabsAppliedByWorktreeId
  if (!priorMarks || Object.keys(priorMarks).length === 0) {
    return next
  }
  const nextMarks = next.defaultTerminalTabsAppliedByWorktreeId
  const merged = { ...priorMarks, ...nextMarks }
  if (nextMarks && Object.keys(merged).length === Object.keys(nextMarks).length) {
    return next
  }
  return { ...next, defaultTerminalTabsAppliedByWorktreeId: merged }
}

/** Preserve omitted incarnations on unchanged bindings or restart loses older-daemon generation proof (#30486). */
function keepPtyIncarnationsForUnchangedBindings(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  const priorIncarnations = prior?.terminalPtyIncarnationsByPaneKey
  if (!prior || !priorIncarnations) {
    return next
  }
  const incoming = next.terminalPtyIncarnationsByPaneKey
  // Incoming writes may supply incarnations for only some panes.
  const kept: Record<string, string> = {}
  for (const [paneKey, incarnationId] of Object.entries(priorIncarnations)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed || (incoming && Object.hasOwn(incoming, paneKey))) {
      continue
    }
    const bindingOf = (session: WorkspaceSessionState): string | undefined =>
      session.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    const priorPtyId = bindingOf(prior)
    if (priorPtyId !== undefined && bindingOf(next) === priorPtyId) {
      kept[paneKey] = incarnationId
    }
  }
  return Object.keys(kept).length > 0
    ? { ...next, terminalPtyIncarnationsByPaneKey: { ...kept, ...incoming } }
    : next
}

export function preserveRuntimeAuthoredWorkspaceSessionFields(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  let result = next
  if (
    next.clientHostedBrowserPagesByWorktree === undefined &&
    prior?.clientHostedBrowserPagesByWorktree !== undefined
  ) {
    result = {
      ...result,
      clientHostedBrowserPagesByWorktree: prior.clientHostedBrowserPagesByWorktree
    }
  }
  // Renderer saves omit main-owned close records.
  if (
    next.closedTerminalTabTombstonesByTabId === undefined &&
    prior?.closedTerminalTabTombstonesByTabId !== undefined
  ) {
    result = {
      ...result,
      closedTerminalTabTombstonesByTabId: prior.closedTerminalTabTombstonesByTabId
    }
  }
  // Union write-once markers or omitted renderer maps would respawn defaults on every attach.
  result = keepPtyIncarnationsForUnchangedBindings(result, prior)
  return unionWriteOnceDefaultTerminalTabsApplied(result, prior)
}
