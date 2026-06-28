import { worktreeIndicatorKind, type StatusIndicatorKind } from './agent-state-indicator'
import { formatBadges } from './worktree-badge-format'
import { windowStart } from './navigation-state'
import type { SessionTab, SessionTabKind } from './session-tab'
import type { WorktreeRow, WorktreeSnapshot } from './worktree-snapshot'

/** One rendered sidebar line. The component renders these top-to-bottom (one
 *  screen row each), and the app maps a mouse-click screen row back to a
 *  selectable worktree (or a terminal tab) through the same list — so render and
 *  hit-testing can never drift. */
export type SidebarLine =
  | { kind: 'header' }
  | { kind: 'spacer' }
  | { kind: 'group'; repo: string }
  | {
      kind: 'row'
      /** Index into the flattened worktree-row list (selection space). */
      index: number
      worktreeId: string
      displayName: string
      badges: string
      indicator: StatusIndicatorKind
      /** True when this worktree's terminal tabs are shown nested below. */
      expanded: boolean
    }
  | {
      kind: 'tab'
      /** The owning worktree's flattened index, so jumping selects it too. */
      index: number
      worktreeId: string
      /** Session tab id (used to activate/jump to the tab). */
      id: string
      tabKind: SessionTabKind
      title: string
      focused: boolean
    }

/** Session tabs per worktree, plus the expand state, for nesting tabs under
 *  workspaces. The same options must reach both the renderer and the mouse
 *  hit-test so the two stay aligned. */
export type SidebarTabsOptions = {
  tabsByWorktree?: ReadonlyMap<string, readonly SessionTab[]>
  expanded?: boolean
  focusedTabId?: string | null
}

export function buildSidebarLines(
  snapshot: WorktreeSnapshot | null,
  resolveKind: (row: WorktreeRow) => StatusIndicatorKind = (row) =>
    worktreeIndicatorKind(row.status, row.agents),
  tabs: SidebarTabsOptions = {}
): SidebarLine[] {
  const lines: SidebarLine[] = [{ kind: 'header' }]
  if (!snapshot) {
    return lines
  }
  const expanded = tabs.expanded ?? false
  let index = 0
  for (const group of snapshot.groups) {
    lines.push({ kind: 'spacer' }, { kind: 'group', repo: group.repo })
    for (const row of group.worktrees) {
      const worktreeTabs = tabs.tabsByWorktree?.get(row.worktreeId) ?? []
      lines.push({
        kind: 'row',
        index,
        worktreeId: row.worktreeId,
        displayName: row.displayName,
        badges: formatBadges(row.badges),
        indicator: resolveKind(row),
        expanded: expanded && worktreeTabs.length > 0
      })
      if (expanded) {
        for (const tab of worktreeTabs) {
          lines.push({
            kind: 'tab',
            index,
            worktreeId: row.worktreeId,
            id: tab.id,
            tabKind: tab.kind,
            title: tab.title,
            focused: tab.id === tabs.focusedTabId
          })
        }
      }
      index += 1
    }
  }
  return lines
}

/** Map a 0-based screen row within the sidebar to a flattened worktree-row
 *  index, or null when the row is not a worktree row (header/group/spacer/tab).
 *  Tabs are not worktree-selectable; they're resolved via {@link tabAtScreenRow}. */
export function rowIndexAtScreenRow(
  lines: readonly SidebarLine[],
  screenRow: number
): number | null {
  const line = lines[screenRow]
  return line && line.kind === 'row' ? line.index : null
}

/** First visible line index for a sidebar of `height` rows that keeps the
 *  selected worktree's row on screen. Shared by the renderer and the mouse
 *  hit-test so the two never window differently (clicks would hit wrong rows). */
export function sidebarWindowStart(
  lines: readonly SidebarLine[],
  selectedIndex: number,
  height: number
): number {
  const selectedLine = lines.findIndex(
    (line) => line.kind === 'row' && line.index === selectedIndex
  )
  return windowStart(Math.max(0, selectedLine), lines.length, height)
}

/** Map a 0-based screen row to the session tab it renders, or null. */
export function tabAtScreenRow(
  lines: readonly SidebarLine[],
  screenRow: number
): { index: number; worktreeId: string; id: string } | null {
  const line = lines[screenRow]
  return line && line.kind === 'tab'
    ? { index: line.index, worktreeId: line.worktreeId, id: line.id }
    : null
}
