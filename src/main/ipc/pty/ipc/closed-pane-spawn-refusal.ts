import { isClosedPaneFenced } from '../../../persistence/terminal-topology/closed-pane-binding-fence'
import type { Store } from '../../../persistence'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'

/**
 * Layout-owner build: a spawn for a pane main closed or took back, which main's layout no longer
 * holds, starts nothing. Its binding would be refused anyway (pty-binding-refusals.ts); refusing
 * first means its startup command never runs.
 */
export function refuseClosedPaneSpawn(
  store: Store | undefined,
  tabId: string | undefined,
  leafId: string | null | undefined
): void {
  // The fence's own key: legacy non-UUID leaf ids are matched, never thrown on.
  if (!tabId || !leafId || !isClosedPaneFenced(`${tabId}:${leafId}`)) {
    return
  }
  const held = (store?.getWorkspaceSessionHostIds() ?? []).some((hostId) =>
    layoutContainsLeafId(
      store?.getWorkspaceSession(hostId)?.terminalLayoutsByTabId?.[tabId]?.root ?? null,
      leafId
    )
  )
  if (!held) {
    throw new Error('terminal_pane_closed')
  }
}
