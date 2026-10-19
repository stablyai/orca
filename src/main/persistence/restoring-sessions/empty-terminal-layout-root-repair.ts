import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { resolveRootlessTerminalLayoutLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
import { deriveHeadlessLegacyTerminalLeafId } from '../../runtime/mobile-session-layout-projection'

function nameEmptyLayoutRoot(
  tabId: string,
  layout: TerminalLayoutSnapshot
): TerminalLayoutSnapshot {
  if (layout.root) {
    return layout
  }
  // Same pane the window would mount, so a binding keeps its leaf; else the id phones already use.
  const leafId =
    resolveRootlessTerminalLayoutLeafId(layout) ?? deriveHeadlessLegacyTerminalLeafId(tabId)
  return { ...layout, root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
}

function nameEmptyLayoutRootsInSession(session: WorkspaceSessionState): WorkspaceSessionState {
  const layouts = session.terminalLayoutsByTabId
  if (!layouts || Object.values(layouts).every((layout) => layout.root)) {
    return session
  }
  return {
    ...session,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(layouts).map(([tabId, layout]) => [tabId, nameEmptyLayoutRoot(tabId, layout)])
    )
  }
}

/**
 * Load-only repair. Sessions saved before tabs named their first pane can hold an empty layout
 * root; a later window save of that unmounted tab would drop a binding main made meanwhile.
 * Naming the pane once here means no save ever carries an empty root.
 */
export function nameEmptyPersistedTerminalLayoutRoots(state: PersistedState): PersistedState {
  const workspaceSession = nameEmptyLayoutRootsInSession(state.workspaceSession)
  const hostSessions = state.workspaceSessionsByHostId
  let hostSessionsChanged = false
  const workspaceSessionsByHostId = hostSessions
    ? Object.fromEntries(
        Object.entries(hostSessions).map(([hostId, session]) => {
          const repaired = session ? nameEmptyLayoutRootsInSession(session) : session
          hostSessionsChanged ||= repaired !== session
          return [hostId, repaired]
        })
      )
    : hostSessions
  if (workspaceSession === state.workspaceSession && !hostSessionsChanged) {
    return state
  }
  return {
    ...state,
    workspaceSession,
    ...(hostSessionsChanged ? { workspaceSessionsByHostId } : {})
  }
}
