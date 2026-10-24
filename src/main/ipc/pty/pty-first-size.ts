import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type PtyGridSize = { cols: number; rows: number }

// Use the historical default for headless terminals no window has measured (#1707).
export const UNMEASURED_PTY_SIZE: PtyGridSize = { cols: 120, rows: 40 }

function isMeasured(size: PtyGridSize | undefined): size is PtyGridSize {
  return (
    size !== undefined &&
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  )
}

/** Prefer measured pane, target group, then lone-group geometry so initial output uses the closest known grid. */
export function resolvePtyFirstSize(measured: {
  pane?: PtyGridSize
  group?: PtyGridSize
  singleGroup?: PtyGridSize
}): PtyGridSize {
  for (const size of [measured.pane, measured.group, measured.singleGroup]) {
    if (isMeasured(size)) {
      return size
    }
  }
  return UNMEASURED_PTY_SIZE
}

/** Use the caller measurement or the main-owned pane's previous grid. */
export function paneSize(
  session: WorkspaceSessionState | null | undefined,
  pane: { tabId?: string; leafId?: string; initialSize?: PtyGridSize }
): PtyGridSize | undefined {
  if (pane.initialSize || !ORCA_LAYOUT_OWNER_IS_MAIN || !pane.tabId || !pane.leafId) {
    return pane.initialSize
  }
  return session?.terminalLayoutsByTabId?.[pane.tabId]?.lastGridsByLeafId?.[pane.leafId]
}
