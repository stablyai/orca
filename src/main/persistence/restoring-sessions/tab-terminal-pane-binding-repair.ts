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

/** Removed leaves cannot claim terminal ownership. */
function mountedPtyIds(layout: TerminalLayoutSnapshot): string[] {
  const bindings = layout.ptyIdsByLeafId ?? {}
  const leafIds = layout.root ? collectLayoutLeafIdsInOrder(layout.root) : Object.keys(bindings)
  return leafIds.flatMap((leafId) => (bindings[leafId] ? [bindings[leafId]] : []))
}

function soleUnboundLeafId(layout: TerminalLayoutSnapshot | undefined): string | undefined {
  const leafId = layout?.root?.type === 'leaf' ? layout.root.leafId : undefined
  return leafId && !layout?.ptyIdsByLeafId?.[leafId] ? leafId : undefined
}

/** Recover unbound single-pane tabs only in live-at-shutdown workspaces; SSH rows require relay session IDs. */
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

/** Repair desktop-restored partitions; paired servers own their layout repairs. */
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

/** Load-time binding lets main retain terminals before panes mount. */
export function bindPersistedTabTerminalPanes(state: PersistedState): PersistedState {
  return repairRestoredSessions(state, bindTabTerminalPanesInSession)
}

/** Sweep before main draws empty tabs the renderer's startup would discard. */
export function sweepPersistedUnattachedTerminalRows(state: PersistedState): PersistedState {
  // Any partition can keep a workspace live in the renderer's merged reconnect plan.
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
