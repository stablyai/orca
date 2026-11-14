import { borrowWorkspaceSession } from '../../../persistence/loading-store/workspace-sessions/session-host-partitions'
import { isClosedPaneFenced } from '../../../persistence/terminal-topology/pane-ownership/closed-pane-binding-fence'
import type { Store } from '../../../persistence/loading-store/store'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'

/** Refuse closed/reclaimed panes before spawning; a later binding refusal cannot undo a startup command. */
export function refuseClosedPaneSpawn(
  store: Store | undefined,
  tabId: string | undefined,
  leafId: string | null | undefined
): void {
  // Match the fence's legacy non-UUID keys without throwing.
  if (!tabId || !leafId || !isClosedPaneFenced(`${tabId}:${leafId}`)) {
    return
  }
  const held = (store?.getWorkspaceSessionHostIds() ?? []).some((hostId) =>
    layoutContainsLeafId(
      borrowWorkspaceSession(store, hostId)?.terminalLayoutsByTabId?.[tabId]?.root ?? null,
      leafId
    )
  )
  if (!held) {
    throw new Error('terminal_pane_closed')
  }
}
