import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'

/** A main-side create always opens its own tab. */
export function runtimeNewTabPlacement(viewMode?: 'terminal' | 'chat'): TerminalPanePlacement {
  return viewMode ? { kind: 'new-tab', row: { viewMode } } : { kind: 'new-tab' }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
