import type { Store } from '../../../persistence'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { ptyIncarnationById } from './ownership-state'

/** The incarnation a local PTY's stop is routed by: this run's spawn or attach, else the saved
 *  pane binding, which is all a tab that never reconnected this run has. */
export function localPtyShutdownIncarnation(
  store: Store | undefined,
  ptyId: string
): string | undefined {
  const live = ptyIncarnationById.get(ptyId)
  if (live || typeof store?.getWorkspaceSession !== 'function') {
    return live
  }
  return savedPaneIncarnation(store.getWorkspaceSession(), ptyId)
}

function savedPaneIncarnation(session: WorkspaceSessionState, ptyId: string): string | undefined {
  const found = new Set<string>()
  for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      const leaves = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, boundPtyId] of Object.entries(leaves)) {
        const incarnationId = session.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${leafId}`]
        if (boundPtyId === ptyId && incarnationId) {
          found.add(incarnationId)
        }
      }
    }
  }
  // Why: two saved panes naming different incarnations cannot say which one this stop means.
  return found.size === 1 ? found.values().next().value : undefined
}
