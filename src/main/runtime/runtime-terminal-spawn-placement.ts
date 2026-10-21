import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'

/**
 * A runtime-started tab opens in the group asked for, else the first group (as the live view). Its
 * title is the caller's name for it when the window would show it too: a revealed tab keeps the
 * name, a background tab (a worker the window never revealed) keeps its live title.
 */
export function newTabIn(opts: {
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  title?: string
  presentation?: RuntimeTerminalPresentation
}): {
  placement: TerminalPanePlacement
  groupId?: string
} {
  const { viewMode, targetGroupId } = opts
  const title = opts.presentation === 'background' ? undefined : opts.title
  const row = {
    ...(viewMode ? { viewMode } : {}),
    ...(title ? { customTitle: title } : {})
  }
  return {
    placement: viewMode || title ? { kind: 'new-tab', row } : { kind: 'new-tab' },
    ...(targetGroupId ? { groupId: targetGroupId } : {})
  }
}

export function runtimeSplitPlacement(
  parentLeafId: string,
  direction: TerminalPaneSplitDirection
): TerminalPanePlacement {
  return { kind: 'split', parentLeafId, direction }
}
