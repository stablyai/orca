import { isClosedPaneFenced } from '../../../persistence/terminal-topology/closed-pane-binding-fence'
import type { Store } from '../../../persistence'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'

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
      store?.getWorkspaceSession(hostId)?.terminalLayoutsByTabId?.[tabId]?.root ?? null,
      leafId
    )
  )
  if (!held) {
    throw new Error('terminal_pane_closed')
  }
}
