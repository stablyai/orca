import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalSummary,
  RuntimeTerminalVisualLayout,
  RuntimeTerminalVisualLayoutNode,
  RuntimeTerminalVisualPaneNode
} from '../../shared/runtime-types'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../shared/runtime-types'

export function annotateRuntimeTerminalVisualTopology(
  terminals: readonly RuntimeTerminalSummary[],
  layouts: readonly RuntimeTerminalVisualLayout[],
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>
): RuntimeTerminalSummary[] {
  const projectedHandles = new Set<string>()
  for (const layout of layouts) {
    collectProjectedHandles(layout.root, projectedHandles)
  }
  const snapshotsByWorktree = new Map(
    [...snapshots].map((snapshot) => [snapshot.worktree, snapshot])
  )
  return terminals.map((terminal) => {
    const snapshot = snapshotsByWorktree.get(terminal.worktreeId)
    if (!snapshot) {
      return terminal
    }
    const surface = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === terminal.tabId &&
        candidate.leafId === terminal.leafId
    )
    if (!surface) {
      if (
        snapshot.publicationEpoch === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH &&
        snapshot.snapshotVersion === 0
      ) {
        return terminal
      }
      return { ...terminal, visualTopologyState: 'detached' }
    }
    const parentSurface = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' && candidate.parentTabId === terminal.tabId
    )
    const ptyBindings = getPtyBindings(surface, parentSurface?.parentLayout)
    if (!terminal.ptyId || ptyBindings.length === 0) {
      return terminal
    }
    if (ptyBindings.some((ptyId) => ptyId !== terminal.ptyId)) {
      return { ...terminal, visualTopologyState: 'detached' }
    }
    if (!surface.incarnationId || !terminal.incarnationId) {
      return terminal
    }
    if (surface.incarnationId !== terminal.incarnationId) {
      return { ...terminal, visualTopologyState: 'detached' }
    }
    return {
      ...terminal,
      visualTopologyState: projectedHandles.has(terminal.handle) ? 'projected' : 'detached'
    }
  })
}

export function getPtyBindings(
  surface: RuntimeMobileSessionTerminalTab,
  parentLayout: RuntimeMobileSessionTerminalTab['parentLayout'] = surface.parentLayout
): string[] {
  return [
    surface.ptyId,
    surface.parentLayout?.ptyIdsByLeafId?.[surface.leafId],
    parentLayout?.ptyIdsByLeafId?.[surface.leafId]
  ].filter((ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0)
}

function collectProjectedHandles(
  node: RuntimeTerminalVisualLayoutNode | RuntimeTerminalVisualPaneNode,
  handles: Set<string>
): void {
  if (node.type === 'terminal') {
    handles.add(node.handle)
    return
  }
  if (node.type === 'group') {
    for (const tab of node.tabs) {
      collectProjectedHandles(tab.panes, handles)
    }
    return
  }
  collectProjectedHandles(node.first, handles)
  collectProjectedHandles(node.second, handles)
}
