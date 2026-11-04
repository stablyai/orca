import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { TerminalPaneSplitDirection } from '../../shared/terminal-tab-types'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'

/** Use requested/first group; revealed tabs honor user names, background worker tabs keep live titles. */
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
