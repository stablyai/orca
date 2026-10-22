// Layout-owner builds: a workspace main owns publishes its rows, tab order and groups from main's
// layout (projectSessionTabs). The window's live publication supplies what the user sees: selection,
// the focused pane, dirty state and live terminal titles (main's copy of the view lags a debounced
// save), the rows main's layout does not list yet, and the facts only the window has (terminal
// theme, agent status, launch drafts, a markdown view's mode, file id, draft version and untitled
// flag).

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import { orderIdOf, placeInMainGroups, withStrayIn } from './main-session-tab-group-placement'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'

type Row = RuntimeMobileSessionSnapshotTab

/** Main's projection of the rows (projectSessionTabs): the snapshot minus the runtime's stamps. */
export type MainSessionTabRows = Omit<
  RuntimeMobileSessionTabsSnapshot,
  'publicationEpoch' | 'snapshotVersion' | 'worktreeInstanceId' | 'retiredTerminalSurfaces'
>

/**
 * Rows main's layout answers for, with the window's facts: terminals and edit-mode files. Main also
 * lists browser, chat, diff and markdown-preview rows, but the window's row of the same id stands
 * whole while the window lists it (its draft is what makes a diff dirty).
 */
function isMainRow(row: Row): boolean {
  return (
    row.type === 'terminal' ||
    (row.type === 'file' && row.mode !== 'diff') ||
    (row.type === 'markdown' && row.mode === 'edit')
  )
}

/** A terminal row with a manual name: its tab's custom title or its pane's own title. */
function isNamed(row: Extract<Row, { type: 'terminal' }>): boolean {
  return !!row.customTitle || !!row.parentLayout?.titlesByLeafId?.[row.leafId]?.trim()
}

type MergeRules = {
  exited: (ptyId: string) => boolean
  /** Whether a terminal runs now; given, a running window terminal outranks a binding that runs nowhere. */
  live?: (ptyId: string) => boolean
  /** Keeps every window row main does not list, terminals too, where they stood in the window. */
  keepUnlisted?: boolean
}

/** Whether the window's terminal id stands over main's binding (see withWindowFacts). */
function keepsWindowPtyId(
  main: string | null | undefined,
  window: string | null | undefined,
  { exited, live }: MergeRules
): boolean {
  if (!window || window === main) {
    return false
  }
  if (!main) {
    return !exited(window)
  }
  // Main's binding names a terminal the host saw exit; the window's has not.
  if (exited(main)) {
    return !exited(window)
  }
  // A start whose bind write is still in flight: main's binding is the terminal it replaced.
  return !!live && live(window) && !live(main)
}

/**
 * Main's row with the fields only the window knows, from the window's row of the same id. A
 * window terminal id names a pane main has not bound yet (an SSH restore before its terminal
 * registers), unless main has seen that terminal exit: then main's cleared binding wins.
 */
function withWindowFacts(row: Row, windowRow: Row | undefined, rules: MergeRules): Row {
  if (row.type === 'terminal' && windowRow?.type === 'terminal') {
    return {
      ...row,
      // The live title (shell or agent) unless either side has a manual name.
      ...(!isNamed(row) && !isNamed(windowRow) ? { title: windowRow.title } : {}),
      ...(windowRow.terminalTheme ? { terminalTheme: windowRow.terminalTheme } : {}),
      ...(windowRow.agentStatus !== undefined ? { agentStatus: windowRow.agentStatus } : {}),
      ...(keepsWindowPtyId(row.ptyId, windowRow.ptyId, rules) ? { ptyId: windowRow.ptyId } : {}),
      ...(windowRow.launchDraft !== undefined ? { launchDraft: windowRow.launchDraft } : {}),
      ...(windowRow.launchDraftCreatedAt !== undefined
        ? { launchDraftCreatedAt: windowRow.launchDraftCreatedAt }
        : {})
    }
  }
  if (row.type === 'markdown' && windowRow?.type === 'markdown') {
    return {
      ...row,
      isDirty: windowRow.isDirty,
      mode: windowRow.mode,
      sourceFileId: windowRow.sourceFileId,
      documentVersion: windowRow.documentVersion,
      // The saved session never records untitled; a phone save must not make its file.
      ...(windowRow.isUntitled ? { isUntitled: true as const } : {})
    }
  }
  if (row.type === 'file' && windowRow?.type === 'file') {
    return { ...row, isDirty: windowRow.isDirty }
  }
  return row
}

/** Main's rows in main's order, each window-only row after the row it follows in the window's. */
function withWindowOnlyRows(
  rows: Row[],
  windowRows: readonly Row[],
  windowOnly: ReadonlySet<string>
): Row[] {
  const merged = [...rows]
  windowRows.forEach((row, index) => {
    if (!windowOnly.has(row.id)) {
      return
    }
    const after = windowRows
      .slice(0, index)
      .toReversed()
      .find((previous) => merged.some((entry) => entry.id === previous.id))
    const at = after ? merged.findIndex((entry) => entry.id === after.id) + 1 : 0
    merged.splice(at, 0, row)
  })
  return merged
}

/**
 * The window's live snapshot of a workspace main owns, with main's terminal and editor rows, tab
 * order and groups. The window keeps its publication stamps (so the snapshot fences hold as today)
 * and its view: what it selects stands whenever main lists that row.
 */
export function withMainSessionTabRows(
  published: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows,
  exited: (ptyId: string) => boolean,
  opts: Omit<MergeRules, 'exited'> = {}
): RuntimeMobileSessionTabsSnapshot {
  const rules = { ...opts, exited }
  const windowRows = new Map(published.tabs.map((row) => [row.id, row]))
  const projectedIds = new Set(projected.tabs.map((row) => row.id))
  const windowOnly = published.tabs.filter(
    (row) => !projectedIds.has(row.id) && (rules.keepUnlisted || !isMainRow(row))
  )
  // A main-held row is main's; a browser or chat row stays the window's while both list it.
  const rows = projected.tabs.map((row) =>
    isMainRow(row)
      ? withWindowFacts(row, windowRows.get(row.id), rules)
      : (windowRows.get(row.id) ?? row)
  )
  const windowOnlyIds = new Set(windowOnly.map((row) => row.id))
  const merged = withWindowOnlyRows(rows, published.tabs, windowOnlyIds)
  const listed = new Map(merged.map((row) => [row.id, row]))
  const windowActive = published.activeTabId ? listed.get(published.activeTabId) : undefined
  const windowGroups = new Map((published.tabGroups ?? []).map((group) => [group.id, group]))
  // Groups list a terminal under its tab (orderIdOf), so a kept pane keeps its tab's place.
  const windowOnlyOrder = new Set(windowOnly.map(orderIdOf))
  const placement = placeInMainGroups(
    projected.tabGroups ?? [],
    published.tabGroups ?? [],
    windowOnlyOrder
  )
  // The tab the window shows in each group, when main's group still holds it; while main's
  // selection stands (the window selects a row main lacks), main's groups stay as main has them.
  let tabGroups: RuntimeMobileSessionTabGroup[] = placement.groups.map((group) => {
    const shown = windowActive ? windowGroups.get(group.id)?.activeTabId : undefined
    return shown && group.tabOrder.includes(shown) ? { ...group, activeTabId: shown } : group
  })
  const activeGroupIndex = (activeRow: Row | undefined): number => {
    const byRow = activeRow
      ? tabGroups.findIndex((group) => group.tabOrder.includes(orderIdOf(activeRow)))
      : -1
    if (byRow !== -1) {
      return byRow
    }
    const byWindow = windowActive
      ? tabGroups.findIndex((group) => group.id === published.activeGroupId)
      : -1
    return byWindow !== -1
      ? byWindow
      : tabGroups.findIndex((group) => group.id === projected.activeGroupId)
  }
  // A window-only row in a group main does not hold joins the active group: groups and their
  // layout are main's, so the phone gets no group the layout lacks.
  const { stray } = placement
  if (tabGroups.length > 0) {
    tabGroups = withStrayIn(tabGroups, stray, Math.max(activeGroupIndex(windowActive), 0))
  } else if (stray.length > 0) {
    // Main lists no group: the window's groups hold the rows only it knows.
    for (const group of published.tabGroups ?? []) {
      const own = group.tabOrder.filter((id) => windowOnlyOrder.has(id))
      if (own.length > 0) {
        tabGroups.push({ ...group, tabOrder: own })
      }
    }
  }
  // The window's selection is the user's view; main's stands only while the window selects a row
  // main does not list (a pane drawn before main's frame, or one main closed).
  const index = activeGroupIndex(windowActive)
  const activeGroup = index === -1 ? undefined : tabGroups[index]
  if (windowActive && activeGroup) {
    tabGroups[index] = { ...activeGroup, activeTabId: orderIdOf(windowActive) }
  }
  const selection = windowActive
    ? {
        activeGroupId: activeGroup?.id ?? projected.activeGroupId,
        activeTabId: windowActive.id,
        activeTabType: windowActive.type
      }
    : {
        activeGroupId: projected.activeGroupId,
        activeTabId: projected.activeTabId,
        activeTabType: projected.activeTabType
      }
  const activeId = selection.activeTabId
  const { tabGroups: _windowGroups, tabGroupLayout: _windowLayout, ...stamps } = published
  return {
    ...stamps,
    ...selection,
    ...(tabGroups.length > 0 ? { tabGroups } : {}),
    ...(projected.tabGroupLayout
      ? { tabGroupLayout: projected.tabGroupLayout }
      : tabGroups.length > 0 && published.tabGroupLayout
        ? { tabGroupLayout: published.tabGroupLayout }
        : {}),
    tabs: merged.map((row) =>
      row.isActive === (row.id === activeId) ? row : { ...row, isActive: row.id === activeId }
    )
  }
}
