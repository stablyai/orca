import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import {
  readCanonicalPtyOwners,
  resolveCanonicalPtyClaim
} from '../../../shared/workspace-layout/legacy-terminal-row-claims'
import {
  liveAtShutdown,
  sweepUnattachedTerminalRows
} from '../../../shared/workspace-layout/unattached-terminal-row-sweep'

/** Terminals a pane in the layout's tree binds; a binding a removed pane left behind holds nothing. */
function mountedPtyIds(layout: TerminalLayoutSnapshot): string[] {
  const bindings = layout.ptyIdsByLeafId ?? {}
  const leafIds = layout.root ? collectLayoutLeafIdsInOrder(layout.root) : Object.keys(bindings)
  return leafIds.flatMap((leafId) => (bindings[leafId] ? [bindings[leafId]] : []))
}

function soleUnboundLeafId(layout: TerminalLayoutSnapshot | undefined): string | undefined {
  const leafId = layout?.root?.type === 'leaf' ? layout.root.leafId : undefined
  return leafId && !layout?.ptyIdsByLeafId?.[leafId] ? leafId : undefined
}

/**
 * Binds each one-pane tab whose layout binds no terminal to the one named on the tab (an older
 * session, or an unvisited SSH tab's relay session), as the window's reconnect rebinds it: only
 * in a workspace live at shutdown, and never to a terminal another pane or a tab-bar tab holds.
 * An SSH workspace's tab takes only its relay session id; its row's id is a wake hint there.
 */
export function bindTabTerminalPanesInSession(
  session: WorkspaceSessionState,
  isSshWorkspace: (key: string) => boolean
): WorkspaceSessionState {
  const live = liveAtShutdown(session)
  const bound = new Set(Object.values(session.terminalLayoutsByTabId ?? {}).flatMap(mountedPtyIds))
  let layouts: Record<string, TerminalLayoutSnapshot> | null = null
  for (const [key, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    if (!live(key)) {
      continue
    }
    let canonical: ReturnType<typeof readCanonicalPtyOwners> | null = null
    for (const row of rows) {
      const layout = (layouts ?? session.terminalLayoutsByTabId)?.[row.id]
      const leafId = soleUnboundLeafId(layout)
      // Reconnect takes the relay session id over the row's.
      const relayId = session.remoteSessionIdsByTabId?.[row.id]
      const named = [relayId, isSshWorkspace(key) ? undefined : row.ptyId].filter(
        (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId !== '' && !bound.has(ptyId)
      )
      if (!layout || !leafId || named.length === 0) {
        continue
      }
      canonical ??= readCanonicalPtyOwners(session, key, rows)
      const claim = resolveCanonicalPtyClaim(session, row, canonical)
      const ptyId = named.find(
        (candidate) => claim.kind === 'retained' && !claim.releasedPtyIds.has(candidate)
      )
      if (!ptyId) {
        continue
      }
      bound.add(ptyId)
      layouts ??= { ...session.terminalLayoutsByTabId }
      layouts[row.id] = { ...layout, ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId } }
    }
  }
  return layouts ? { ...session, terminalLayoutsByTabId: layouts } : session
}

type SessionRepair = (
  session: WorkspaceSessionState,
  isSshWorkspace: (key: string) => boolean
) => WorkspaceSessionState

/** Repairs every partition this desktop restores; a paired server's is the server's and passes through. */
function repairRestoredSessions(state: PersistedState, repair: SessionRepair): PersistedState {
  const sshRepoIds = new Set(state.repos.filter((repo) => repo.connectionId).map((repo) => repo.id))
  const sshRepoWorkspace = (key: string): boolean => sshRepoIds.has(getRepoIdFromWorktreeId(key))
  const workspaceSession = repair(state.workspaceSession, sshRepoWorkspace)
  let hostSessionsChanged = false
  const workspaceSessionsByHostId = state.workspaceSessionsByHostId
    ? Object.fromEntries(
        Object.entries(state.workspaceSessionsByHostId).map(([hostId, session]) => {
          const kind = parseExecutionHostId(hostId)?.kind
          const repaired =
            session && kind !== 'runtime'
              ? repair(session, kind === 'ssh' ? () => true : sshRepoWorkspace)
              : session
          hostSessionsChanged ||= repaired !== session
          return [hostId, repaired]
        })
      )
    : state.workspaceSessionsByHostId
  if (workspaceSession === state.workspaceSession && !hostSessionsChanged) {
    return state
  }
  return {
    ...state,
    workspaceSession,
    ...(hostSessionsChanged ? { workspaceSessionsByHostId } : {})
  }
}

/**
 * Load-only repair for layout-owner builds: main's layout holds these terminals from the start, so
 * its frames and saves keep them before the pane mounts.
 */
export function bindPersistedTabTerminalPanes(state: PersistedState): PersistedState {
  return repairRestoredSessions(state, bindTabTerminalPanesInSession)
}

/**
 * Load-only repair for layout-owner builds: rows outside the tab bar the window's startup would
 * sweep go once, before main's layout would draw each as an empty tab.
 */
export function sweepPersistedUnattachedTerminalRows(state: PersistedState): PersistedState {
  // Why any partition's list too: a stale list can name another partition's workspace, which the
  // window's merged list then counts live; keeping on either never sweeps a row the window keeps.
  const listedAnywhere = new Set(
    [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})].flatMap(
      (session) => session?.activeWorktreeIdsOnShutdown ?? []
    )
  )
  return repairRestoredSessions(state, (session) => {
    const ownLive = liveAtShutdown(session)
    return sweepUnattachedTerminalRows(session, (key) => ownLive(key) || listedAnywhere.has(key))
  })
}
