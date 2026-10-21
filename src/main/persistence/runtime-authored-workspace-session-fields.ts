import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../shared/stable-pane-id'

/**
 * Keeps session fields the renderer persist snapshot does not author across a full write.
 *
 * A session write replaces the stored object. Zustand-built payloads omit runtime-owned
 * client-hosted pages and terminal close records, and they omit-when-empty the write-once
 * default-terminal-tab marker. Without this, those slices vanish on the next desktop write and
 * only show up missing after restart.
 *
 * Callers do not opt in: the Store applies this inside setLocalWorkspaceSession and
 * setHostWorkspaceSession, so the before-unload stage path inherits it too.
 *
 * A runtime clearing client-hosted pages writes an empty map, not `undefined`. The default-tab
 * marker is write-once: omission means "never stamped", not "never applied".
 */
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

/**
 * Keeps main's PTY incarnation for each pane the write still binds to the same PTY. Why: the
 * renderer never carries this map, so its save erased it and every restart reattached without the
 * generation proof that disambiguates an older daemon that cannot answer (#30486).
 */
function keepPtyIncarnationsForUnchangedBindings(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  const priorIncarnations = prior?.terminalPtyIncarnationsByPaneKey
  if (!prior || !priorIncarnations) {
    return next
  }
  const incoming = next.terminalPtyIncarnationsByPaneKey
  // Per pane: a write may carry only some panes' incarnations.
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
  // Why: close records are main's alone (its close transaction); a renderer save never carries them.
  if (
    next.closedTerminalTabTombstonesByTabId === undefined &&
    prior?.closedTerminalTabTombstonesByTabId !== undefined
  ) {
    result = {
      ...result,
      closedTerminalTabTombstonesByTabId: prior.closedTerminalTabTombstonesByTabId
    }
  }
  // Why union: persist snapshots omit this write-once map (empty Zustand slice, omit-when-empty
  // payload). Treating omission as "never applied" re-spawns default terminals on every attach.
  result = keepPtyIncarnationsForUnchangedBindings(result, prior)
  return unionWriteOnceDefaultTerminalTabsApplied(result, prior)
}
