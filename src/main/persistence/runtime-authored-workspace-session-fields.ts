import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Keeps session fields the renderer persist snapshot does not author across a full write.
 *
 * A session write replaces the stored object. Zustand-built payloads omit runtime-owned
 * client-hosted pages, and they omit-when-empty the write-once default-terminal-tab marker.
 * Without this, those slices vanish on the next desktop write and only show up missing after
 * restart.
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
  // Why union: persist snapshots omit this write-once map (empty Zustand slice, omit-when-empty
  // payload). Treating omission as "never applied" re-spawns default terminals on every attach.
  return unionWriteOnceDefaultTerminalTabsApplied(result, prior)
}
